import { WebSocketServer, WebSocket } from "ws";
import { EventEmitter } from "node:events";
import type { ClientMessage, ServerMessage } from "./protocol.js";
import {
  isJoinRequest,
  isPromptMessage,
  isApprovalResponse,
  isChatMessage,
  isWhisperMessage,
  isTypingMessage,
  isAgentModeToggle,
  isContextModeChange,
  isAgenticDiscussionStart,
} from "./protocol.js";
import { deriveKey, encrypt, decrypt } from "./crypto.js";
import { ParticipantRegistry } from "./participant.js";
import type { Participant } from "./participant.js";
import type { DuetTransport } from "./transport.js";

export interface ServerOptions {
  hostUser: string;
  password: string;
  sessionCode: string;
  approvalMode?: boolean;
  maxParticipants?: number;
  maxAgentHops?: number;
}

const DEFAULT_MAX_PARTICIPANTS = 10;
const DEFAULT_MAX_AGENT_HOPS = 10;

// How often to send WebSocket ping frames (ms).
// Must be well under typical tunnel/proxy idle timeouts (localtunnel = 120s).
const HEARTBEAT_INTERVAL_MS = 30_000;

export class TeamCodingServer extends EventEmitter {
  private wss?: WebSocketServer;
  private options: Required<ServerOptions>;
  private encryptionKey: Uint8Array;
  private registry: ParticipantRegistry;
  private nextSeq = 1;
  private heartbeatTimer?: ReturnType<typeof setInterval>;

  // Buffer of stream events from the current Claude turn.
  // Replayed to participants who join mid-response so they don't see a truncated stream.
  private activeStreamBuffer: ServerMessage[] = [];

  // Legacy transport support (for P2P/relay)
  private transportParticipants = new Map<DuetTransport, string>(); // transport → participantId

  constructor(options: ServerOptions) {
    super();
    this.options = {
      approvalMode: true,
      maxParticipants: DEFAULT_MAX_PARTICIPANTS,
      maxAgentHops: DEFAULT_MAX_AGENT_HOPS,
      ...options,
    };
    this.encryptionKey = deriveKey(options.password, options.sessionCode);
    this.registry = new ParticipantRegistry();
  }

  getRegistry(): ParticipantRegistry {
    return this.registry;
  }

  /**
   * Register the host as a local participant (no WebSocket).
   */
  registerHost(): Participant {
    return this.registry.add(this.options.hostUser, "host", null);
  }

  async start(port = 0): Promise<number> {
    return new Promise((resolve) => {
      this.wss = new WebSocketServer({ port });
      this.wss.on("listening", () => {
        const addr = this.wss!.address();
        const listeningPort = typeof addr === "object" && addr !== null ? addr.port : 0;
        this.startHeartbeat();
        resolve(listeningPort);
      });
      this.wss.on("connection", (ws) => this.handleConnection(ws));
    });
  }

  /**
   * Send a ping frame to every connected WebSocket client every HEARTBEAT_INTERVAL_MS.
   * Clients that miss a pong are terminated (dead connection detection).
   * This keeps connections alive through tunnels/proxies that impose idle timeouts
   * (e.g. localtunnel drops connections after ~120 s of inactivity).
   */
  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      for (const participant of this.registry.getRemote()) {
        const ws = participant.ws;
        if (!ws || ws.readyState !== WebSocket.OPEN) continue;

        if ((ws as any)._tcAlive === false) {
          // Missed the previous pong — connection is dead, terminate it
          ws.terminate();
          continue;
        }

        (ws as any)._tcAlive = false;
        ws.ping();
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  attachTransport(transport: DuetTransport): void {
    transport.on("message", (data: string) => {
      try {
        const decrypted = decrypt(data, this.encryptionKey);
        const msg: unknown = JSON.parse(decrypted);
        this.handleTransportMessage(transport, msg);
      } catch {
        // Ignore malformed or undecryptable messages
      }
    });

    transport.on("close", () => {
      const participantId = this.transportParticipants.get(transport);
      if (participantId) {
        const participant = this.registry.getById(participantId);
        if (participant) {
          this.registry.remove(participantId);
          this.transportParticipants.delete(transport);
          this.broadcastParticipantLeft(participant);
        }
      }
    });
  }

  /**
   * Buffer a streaming event (stream_chunk / tool_use / tool_result) and broadcast it.
   * Participants who join mid-turn will receive the buffered events to catch up.
   * Call clearStreamBuffer() when a turn completes.
   */
  bufferStreamEvent(msg: ServerMessage): void {
    this.activeStreamBuffer.push(msg);
    this.broadcast(msg);
  }

  /**
   * Clear the active stream buffer. Call this after a turn_complete event.
   */
  clearStreamBuffer(): void {
    this.activeStreamBuffer = [];
  }

  private handleConnection(ws: WebSocket): void {
    // Check capacity
    if (this.registry.size() >= this.options.maxParticipants) {
      const payload: ServerMessage = {
        type: "join_rejected",
        reason: `Session is full (max ${this.options.maxParticipants} participants)`,
        timestamp: Date.now(),
      };
      ws.send(encrypt(JSON.stringify(payload), this.encryptionKey), () => {
        ws.close();
      });
      return;
    }

    // Mark alive on pong — heartbeat uses this to detect dead connections
    (ws as any)._tcAlive = true;
    ws.on("pong", () => { (ws as any)._tcAlive = true; });

    // Handle WebSocket errors gracefully.
    // An "error" event without a listener would become an uncaught exception and crash the host.
    // Errors are always followed by a "close" event which handles participant cleanup.
    ws.on("error", () => {
      // Intentionally empty: cleanup is handled in the "close" handler below.
    });

    ws.on("message", (data) => {
      try {
        const decrypted = decrypt(data.toString(), this.encryptionKey);
        const msg: unknown = JSON.parse(decrypted);
        this.handleMessage(ws, msg);
      } catch {
        // Ignore malformed or undecryptable messages
      }
    });

    ws.on("close", () => {
      const participant = this.registry.removeByWs(ws);
      if (participant) {
        this.broadcastParticipantLeft(participant);
      }
    });
  }

  private handleTransportMessage(transport: DuetTransport, msg: unknown): void {
    if (isJoinRequest(msg)) {
      if (msg.passwordHash !== this.options.password) {
        this.sendTransport(transport, {
          type: "join_rejected",
          reason: "Invalid password",
          timestamp: Date.now(),
        });
        return;
      }

      if (this.registry.size() >= this.options.maxParticipants) {
        this.sendTransport(transport, {
          type: "join_rejected",
          reason: `Session is full (max ${this.options.maxParticipants} participants)`,
          timestamp: Date.now(),
        });
        return;
      }

      if (!this.registry.isNameAvailable(msg.user)) {
        this.sendTransport(transport, {
          type: "join_rejected",
          reason: `Name "${msg.user}" is already taken`,
          timestamp: Date.now(),
        });
        return;
      }

      // Create participant with null ws (transport-based)
      const participant = this.registry.add(msg.user, "participant", null);
      this.transportParticipants.set(transport, participant.id);

      this.sendTransport(transport, {
        type: "join_accepted",
        sessionId: "session",
        hostUser: this.options.hostUser,
        approvalMode: this.options.approvalMode,
        participantId: participant.id,
        participants: this.registry.toInfoList(),
        maxAgentHops: this.options.maxAgentHops,
        timestamp: Date.now(),
      });

      this.broadcastParticipantJoined(participant);
      this.emit("participant_joined", participant.name);
      return;
    }

    // For non-join messages, find the participant by transport
    const participantId = this.transportParticipants.get(transport);
    if (!participantId) return;
    const participant = this.registry.getById(participantId);
    if (!participant) return;

    this.routeMessage(msg, participant);
  }

  private handleMessage(ws: WebSocket, msg: unknown): void {
    if (isJoinRequest(msg)) {
      if (msg.passwordHash !== this.options.password) {
        this.send(ws, {
          type: "join_rejected",
          reason: "Invalid password",
          timestamp: Date.now(),
        });
        return;
      }

      if (!this.registry.isNameAvailable(msg.user)) {
        this.send(ws, {
          type: "join_rejected",
          reason: `Name "${msg.user}" is already taken`,
          timestamp: Date.now(),
        });
        return;
      }

      const participant = this.registry.add(msg.user, "participant", ws);

      this.send(ws, {
        type: "join_accepted",
        sessionId: "session",
        hostUser: this.options.hostUser,
        approvalMode: this.options.approvalMode,
        participantId: participant.id,
        participants: this.registry.toInfoList(),
        maxAgentHops: this.options.maxAgentHops,
        timestamp: Date.now(),
      });

      // Replay any in-progress Claude stream so a late joiner doesn't see a truncated response.
      // This runs synchronously before the next broadcast(), so there's no duplicate-chunk race.
      if (this.activeStreamBuffer.length > 0) {
        for (const bufferedMsg of this.activeStreamBuffer) {
          this.send(ws, bufferedMsg);
        }
      }

      this.broadcastParticipantJoined(participant);
      this.emit("participant_joined", participant.name);
      return;
    }

    // For non-join messages, look up the participant by ws
    const participant = this.registry.getByWs(ws);
    if (!participant) return;

    this.routeMessage(msg, participant);
  }

  /**
   * Route a message from a participant based on its type.
   */
  private routeMessage(msg: unknown, sender: Participant): void {
    const senderInfo = this.registry.toIdentity(sender);

    if (isPromptMessage(msg)) {
      msg.user = sender.name;
      msg.source = sender.role;
      msg.sender = senderInfo;
      msg.contextMode = sender.contextMode;
      this.emit("prompt", msg);
      return;
    }

    if (isApprovalResponse(msg)) {
      this.emit("approval_response", msg);
      return;
    }

    if (isChatMessage(msg)) {
      msg.user = sender.name;
      msg.source = sender.role;
      msg.sender = senderInfo;
      const outMsg: ServerMessage = {
        type: "chat_received",
        user: sender.name,
        text: msg.text,
        source: sender.role,
        sender: senderInfo,
        isAgentResponse: msg.isAgentResponse,
        agentHops: msg.agentHops,
        seq: this.nextSeq++,
        timestamp: Date.now(),
      };
      this.broadcast(outMsg);
      this.emit("chat", msg);
      // Enforce hop limit: if this agent message hit the ceiling, stop the discussion
      if (msg.isAgentResponse && msg.agentHops !== undefined && msg.agentHops >= this.options.maxAgentHops!) {
        this.broadcast({
          type: "agent_chain_stop",
          reason: "hop_limit",
          seq: this.nextSeq++,
          timestamp: Date.now(),
        });
      }
      return;
    }

    if (isWhisperMessage(msg)) {
      msg.sender = senderInfo;
      this.handleWhisper(msg, sender);
      return;
    }

    if (isTypingMessage(msg)) {
      const indicator: ServerMessage = {
        type: "typing_indicator",
        user: sender.name,
        isTyping: msg.isTyping,
        timestamp: Date.now(),
      } as ServerMessage;

      if (!msg.targets) {
        // No targets field — broadcast to everyone except sender
        this.broadcast(indicator, [sender.id]);
      } else if (msg.targets.length > 0) {
        // Targeted — send only to the named participants
        for (const targetName of msg.targets) {
          const target = this.registry.getByName(targetName);
          if (target && target.id !== sender.id) {
            this.sendTo(target.id, indicator);
          }
        }
      }
      // msg.targets === [] → suppress, send to nobody
      return;
    }

    if (isAgentModeToggle(msg)) {
      sender.agentMode = msg.enabled;
      const notice: ServerMessage = {
        type: "notice",
        message: `${sender.name} ${msg.enabled ? "enabled" : "disabled"} agent mode`,
        seq: this.nextSeq++,
        timestamp: Date.now(),
      };
      this.broadcast(notice);
      this.emit("agent_mode_changed", sender, msg.enabled);
      return;
    }

    if (isContextModeChange(msg)) {
      sender.contextMode = msg.mode;
      this.emit("context_mode_changed", sender, msg.mode);
      return;
    }

    if (isAgenticDiscussionStart(msg)) {
      const discussionMsg: ServerMessage = {
        type: "agent_discussion_start",
        topic: msg.topic,
        initiator: sender.name,
        seq: this.nextSeq++,
        timestamp: Date.now(),
      };
      this.broadcast(discussionMsg);
      return;
    }
  }

  /**
   * Handle whisper messages — send only to named targets + echo to sender.
   */
  private handleWhisper(msg: import("./protocol.js").WhisperMessage, sender: Participant): void {
    const whisperOut: ServerMessage = {
      type: "whisper_received",
      sender: this.registry.toIdentity(sender),
      targets: msg.targets,
      text: msg.text,
      seq: this.nextSeq++,
      timestamp: Date.now(),
    };

    // Send to each target
    for (const targetName of msg.targets) {
      const target = this.registry.getByName(targetName);
      if (target) {
        if (target.ws) {
          this.send(target.ws, whisperOut);
        } else if (target.role === "host") {
          // Host is local — emit as server_message
          this.emit("server_message", whisperOut);
        }
      }
    }

    // Echo to sender (so they see their own whisper)
    if (sender.ws) {
      this.send(sender.ws, whisperOut);
    }
  }

  /**
   * Inject a message from the host (local participant, no WebSocket).
   */
  injectLocalMessage(msg: unknown): void {
    const host = this.registry.getHost();
    if (!host) return;
    this.routeMessage(msg, host);
  }

  /**
   * Broadcast a message to all participants (remote via WebSocket, host via event).
   */
  broadcast(msg: ServerMessage, excludeIds?: string[]): void {
    const encrypted = encrypt(JSON.stringify(msg), this.encryptionKey);

    for (const participant of this.registry.getRemote()) {
      if (excludeIds?.includes(participant.id)) continue;

      if (participant.ws?.readyState === WebSocket.OPEN) {
        participant.ws.send(encrypted);
      }
    }

    // Also check transport-based participants
    for (const [transport, pid] of this.transportParticipants) {
      if (excludeIds?.includes(pid)) continue;
      if (transport.isOpen()) {
        transport.send(encrypted);
      }
    }

    // Also emit locally for host TUI
    this.emit("server_message", msg);
  }

  /**
   * Send a message to a specific participant by ID.
   */
  sendTo(participantId: string, msg: ServerMessage): void {
    const participant = this.registry.getById(participantId);
    if (!participant) return;

    if (participant.ws?.readyState === WebSocket.OPEN) {
      this.send(participant.ws, msg);
      return;
    }

    // Check transport-based participants
    for (const [transport, pid] of this.transportParticipants) {
      if (pid === participantId && transport.isOpen()) {
        this.sendTransport(transport, msg);
        return;
      }
    }

    // If host, emit locally
    if (participant.role === "host") {
      this.emit("server_message", msg);
    }
  }

  /**
   * Send a message to a participant by name.
   */
  sendToByName(name: string, msg: ServerMessage): void {
    const participant = this.registry.getByName(name);
    if (participant) this.sendTo(participant.id, msg);
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      const encrypted = encrypt(JSON.stringify(msg), this.encryptionKey);
      ws.send(encrypted);
    }
  }

  private sendTransport(transport: DuetTransport, msg: ServerMessage): void {
    if (transport.isOpen()) {
      const encrypted = encrypt(JSON.stringify(msg), this.encryptionKey);
      transport.send(encrypted);
    }
  }

  private broadcastParticipantJoined(participant: Participant): void {
    const msg: ServerMessage = {
      type: "participant_joined",
      participant: {
        id: participant.id,
        name: participant.name,
        role: participant.role,
        agentMode: participant.agentMode,
        contextMode: participant.contextMode,
      },
      seq: this.nextSeq++,
      timestamp: Date.now(),
    };
    // Broadcast to all except the new participant
    this.broadcast(msg, [participant.id]);
  }

  private broadcastParticipantLeft(participant: Participant): void {
    const msg: ServerMessage = {
      type: "participant_left",
      participant: { id: participant.id, name: participant.name },
      seq: this.nextSeq++,
      timestamp: Date.now(),
    };
    this.broadcast(msg);
    this.emit("participant_left", participant.name);
  }

  kickParticipant(name: string): boolean {
    const participant = this.registry.getByName(name);
    if (!participant || participant.role === "host") return false;

    const errorMsg: ServerMessage = {
      type: "error",
      message: "You have been disconnected by the host.",
      timestamp: Date.now(),
    };

    if (participant.ws) {
      this.send(participant.ws, errorMsg);
      participant.ws.close();
    }

    // Check transport-based
    for (const [transport, pid] of this.transportParticipants) {
      if (pid === participant.id) {
        this.sendTransport(transport, errorMsg);
        transport.close();
        this.transportParticipants.delete(transport);
        break;
      }
    }

    this.registry.remove(participant.id);
    this.broadcastParticipantLeft(participant);
    return true;
  }

  /**
   * Remotely disable a participant's agent mode.
   */
  disableAgentMode(name: string): boolean {
    const participant = this.registry.getByName(name);
    if (!participant || !participant.agentMode) return false;

    participant.agentMode = false;

    const toggleMsg: ServerMessage = {
      type: "agent_mode_toggle",
      enabled: false,
      participantId: participant.id,
      timestamp: Date.now(),
    };
    this.sendTo(participant.id, toggleMsg);

    const notice: ServerMessage = {
      type: "notice",
      message: `Host disabled ${participant.name}'s agent mode`,
      seq: this.nextSeq++,
      timestamp: Date.now(),
    };
    this.broadcast(notice);
    return true;
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    for (const participant of this.registry.getRemote()) {
      participant.ws?.close();
    }
    for (const [transport] of this.transportParticipants) {
      transport.close();
    }
    return new Promise((resolve) => {
      if (this.wss) {
        this.wss.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  isAnyParticipantConnected(): boolean {
    // Check ws-based participants
    const hasWsConnected = this.registry.getRemote().some(
      (p) => p.ws && p.ws.readyState === WebSocket.OPEN
    );
    // Check transport-based participants
    const hasTransportConnected = Array.from(this.transportParticipants.keys()).some((t) => t.isOpen());
    return hasWsConnected || hasTransportConnected;
  }

  getParticipantNames(): string[] {
    return this.registry.getAll().map((p) => p.name);
  }

  // Legacy compat
  getGuestUser(): string | undefined {
    const remotes = this.registry.getRemote();
    return remotes.length > 0 ? remotes[0].name : undefined;
  }

  isGuestConnected(): boolean {
    return this.isAnyParticipantConnected();
  }

  kickGuest(): void {
    const remotes = this.registry.getRemote();
    if (remotes.length > 0) {
      this.kickParticipant(remotes[0].name);
    }
  }
}
