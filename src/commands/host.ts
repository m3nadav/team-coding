import { TeamCodingServer } from "../server.js";
import { ClaudeBridge, type PermissionMode } from "../claude.js";
import { LocalClaude } from "../local-claude.js";
import { PromptRouter } from "../router.js";
import { TerminalUI } from "../ui.js";
import { getLocalIP, formatConnectionInfo, startCloudflareTunnel, startLocaltunnel, type ConnectionInfo } from "../connection.js";
import { SessionManager } from "../session.js";
import { handleSlashCommand, parseWhisper, resolveTypingTargets, type CommandContext } from "./session-commands.js";
import { parseSessionHistory, getProjectSessionDir } from "../history.js";
import { join } from "node:path";

interface HostOptions {
  name: string;
  noApproval: boolean;
  tunnel?: "localtunnel" | "cloudflare" | "lan";
  relay?: string;
  port: number;
  continueSession?: boolean;
  resumeSession?: string;
  permissionMode?: PermissionMode;
  withClaude?: boolean;
  maxAgentHops?: number;
  debug?: boolean;
}

export async function hostCommand(options: HostOptions): Promise<void> {
  const debugEnabled = options.debug ?? false;
  const debug = (msg: string) => {
    if (!debugEnabled) return;
    const ts = new Date().toISOString().slice(11, 23);
    process.stderr.write(`[${ts}] [debug] ${msg}\n`);
  };

  process.on("uncaughtException", (err) => {
    debug(`uncaughtException: ${err.stack ?? err.message}`);
    process.stderr.write(`\n[team-coding] Unexpected error: ${err.message}\n`);
    if (debugEnabled) process.stderr.write(`${err.stack}\n`);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    debug(`unhandledRejection: ${stack ?? msg}`);
    process.stderr.write(`\n[team-coding] Unhandled error: ${msg}\n`);
    if (debugEnabled && stack) process.stderr.write(`${stack}\n`);
    process.exit(1);
  });

  debug(`host started name=${options.name}`);

  const sessionManager = new SessionManager();
  const session = sessionManager.create(options.name);
  const approvalMode = !options.noApproval;
  const maxAgentHops = options.maxAgentHops ?? 10;

  const ui = new TerminalUI({ userName: options.name, role: "host" });

  // Create server first so event handler can reference it
  const server = new TeamCodingServer({
    hostUser: options.name,
    password: session.password,
    sessionCode: session.code,
    approvalMode,
    maxAgentHops,
  });
  server.registerHost();

  const claude = new ClaudeBridge({
    continue: options.continueSession,
    resume: options.resumeSession,
    permissionMode: options.permissionMode ?? "auto",
  });

  let claudeSessionId: string | undefined;
  let totalCost = 0;

  // Register event handler BEFORE start() to catch early errors
  claude.on("event", (event) => {
    debug(`claude event: ${event.type}${event.type === "tool_use" ? ` (${event.tool})` : ""}`);
    switch (event.type) {
      case "session_init":
        claudeSessionId = event.sessionId;
        break;
      case "stream_chunk":
        ui.showStreamChunk(event.text);
        // Buffer so late-joining participants can catch up on the current response
        server.bufferStreamEvent({ ...event, timestamp: Date.now() });
        break;
      case "tool_use":
        ui.showToolUse(event.tool, event.input);
        server.bufferStreamEvent({ ...event, timestamp: Date.now() });
        break;
      case "tool_result":
        ui.showToolResult(event.tool, event.output);
        server.bufferStreamEvent({ ...event, timestamp: Date.now() });
        break;
      case "turn_complete":
        debug(`turn_complete cost=$${event.cost.toFixed(4)} duration=${event.durationMs}ms`);
        totalCost += event.cost;
        ui.showTurnComplete(event.cost, event.durationMs);
        // Clear the stream buffer now that the turn is done, then broadcast completion
        server.clearStreamBuffer();
        server.broadcast({ ...event, timestamp: Date.now() });
        break;
      case "notice":
        ui.showSystem(event.message);
        server.broadcast({ type: "notice", message: event.message, timestamp: Date.now() });
        break;
      case "error":
        debug(`claude error: ${event.message}`);
        ui.showError(event.message);
        server.broadcast({ type: "error", message: event.message, timestamp: Date.now() });
        break;
    }
  });

  await claude.start();

  // --- Local Claude for host agent mode and discussion moderation ---
  let localClaude: LocalClaude | undefined;
  let localSessionId: string | undefined;

  // Step 1: agent mode state
  let agentModeEnabled = false;
  let isHostAgentTurn = false;
  let agentResponseBuffer = "";
  let lastAgentResponseTime = 0;
  let currentIncomingHops = 0;
  const AGENT_RATE_LIMIT_MS = 5000;

  // Step 2: discussion mode state
  let discussionMode = false;
  let discussionTopic = "";
  let isModerating = false;
  let moderationBuffer = "";
  let firstDiscussionMessage = true;
  const pendingModerationMessages: Array<{ sender: string; text: string; hops: number }> = [];
  const DISCUSSION_SILENCE_TIMEOUT_MS = 10_000;
  let discussionSilenceTimer: ReturnType<typeof setTimeout> | undefined;

  // Round-robin turn ordering for discussions
  let discussionTurnOrder: string[] = []; // names of participants with agent mode
  let discussionTurnIndex = 0;

  function stopDiscussion(reason: "ai_moderation" | "hop_limit" | "manual" | "silence"): void {
    discussionMode = false;
    isModerating = false;
    moderationBuffer = "";
    pendingModerationMessages.length = 0;
    isHostAgentTurn = false;
    agentResponseBuffer = "";
    discussionTurnOrder = [];
    if (discussionSilenceTimer) { clearTimeout(discussionSilenceTimer); discussionSilenceTimer = undefined; }
    server.broadcast({
      type: "agent_chain_stop",
      reason,
      seq: 0,
      timestamp: Date.now(),
    });
    const reasonMsg = reason === "hop_limit"
      ? "reached the maximum number of exchanges"
      : reason === "ai_moderation"
      ? "host's agent decided it reached its conclusion"
      : reason === "silence"
      ? "no agent responded for 10 seconds"
      : "was manually ended";
    ui.showSystem(`[system] Agentic discussion ended — ${reasonMsg}.`);
  }

  function resetSilenceTimer(): void {
    if (discussionSilenceTimer) clearTimeout(discussionSilenceTimer);
    if (!discussionMode) return;
    discussionSilenceTimer = setTimeout(() => {
      if (discussionMode) stopDiscussion("silence");
    }, DISCUSSION_SILENCE_TIMEOUT_MS);
  }

  function buildTurnOrder(): string[] {
    const order: string[] = [];
    // Add host if they have agent mode
    if (agentModeEnabled) order.push(options.name);
    // Add remote participants with agent mode
    for (const p of server.getRegistry().getRemote()) {
      if (p.agentMode) order.push(p.name);
    }
    return order;
  }

  function broadcastNextTurn(): void {
    if (!discussionMode || discussionTurnOrder.length === 0) return;
    discussionTurnIndex = discussionTurnIndex % discussionTurnOrder.length;
    const nextName = discussionTurnOrder[discussionTurnIndex];
    server.broadcast({
      type: "agent_discussion_turn",
      speaker: nextName,
      topic: discussionTopic,
      timestamp: Date.now(),
    } as any);
  }

  function advanceTurn(): void {
    discussionTurnIndex++;
    broadcastNextTurn();
    resetSilenceTimer();
  }

  function processModerationMessage(entry: { sender: string; text: string; hops: number }): void {
    if (!localClaude || localClaude.isBusy()) {
      pendingModerationMessages.push(entry);
      return;
    }
    isModerating = true;
    moderationBuffer = "";
    const prompt = firstDiscussionMessage
      ? `You are moderating a multi-agent discussion in a collaborative coding session.\nTopic: "${discussionTopic}"\n\nEvaluate each agent message and decide if the discussion is still productive.\nRespond with exactly one word: CONTINUE or STOP.\n\nFirst agent message:\n[${entry.sender}]: ${entry.text}\n\nContinue or Stop?`
      : `[${entry.sender}]: ${entry.text}\n\nContinue or Stop?`;
    firstDiscussionMessage = false;
    localClaude.sendPrompt(prompt);
  }

  if (options.withClaude) {
    localClaude = new LocalClaude({ cwd: process.cwd() });
    localClaude.on("event", (event: any) => {
      switch (event.type) {
        case "stream_chunk":
          if (isModerating) {
            moderationBuffer += event.text;
          } else {
            ui.showLocalClaudeChunk(event.text);
            if (isHostAgentTurn) agentResponseBuffer += event.text;
          }
          break;
        case "session_init":
          if (!localSessionId) {
            localSessionId = event.sessionId;
            ui.showSystem("Local Claude ready.");
          }
          break;
        case "tool_use":
          if (!isModerating) ui.showSystem(`[local: ${event.tool}]`);
          break;
        case "turn_complete":
          if (isModerating) {
            // Check moderation verdict
            const verdict = moderationBuffer.trim().toUpperCase();
            isModerating = false;
            moderationBuffer = "";
            if (verdict.startsWith("STOP")) {
              stopDiscussion("ai_moderation");
            } else {
              // CONTINUE — process any queued messages
              if (pendingModerationMessages.length > 0) {
                processModerationMessage(pendingModerationMessages.shift()!);
              }
            }
          } else {
            ui.showLocalClaudeTurnComplete(event.cost, event.durationMs);
            if (isHostAgentTurn) {
              const response = agentResponseBuffer.trim();
              const outgoingHops = currentIncomingHops + 1;
              isHostAgentTurn = false;
              agentResponseBuffer = "";
              if (response) {
                lastAgentResponseTime = Date.now();
                ui.showUserPrompt(options.name, response, "host", "agent" as any);
                server.broadcast({
                  type: "chat_received",
                  user: options.name,
                  text: response,
                  source: "host",
                  isAgentResponse: true,
                  agentHops: discussionMode ? outgoingHops : undefined,
                  timestamp: Date.now(),
                });
              }
            }
          }
          break;
        case "error":
          if (!isModerating) ui.showLocalClaudeError(event.message);
          isHostAgentTurn = false;
          isModerating = false;
          agentResponseBuffer = "";
          moderationBuffer = "";
          break;
      }
    });
    localClaude.start().then(() => {
      ui.showLocalClaudeStatus(true);
    }).catch((err: Error) => {
      ui.showLocalClaudeError(`Failed to start local Claude: ${err.message}`);
      localClaude = undefined;
    });
  }

  let connInfo: ConnectionInfo | undefined;

  // Determine connection mode — always start WS server
  const port = await server.start(options.port || 0);

  if (options.tunnel || options.relay) {
    if (options.tunnel === "cloudflare") {
      try {
        ui.showSystem("Starting Cloudflare tunnel...");
        connInfo = await startCloudflareTunnel(port);
        ui.showSystem(`Tunnel ready: ${connInfo.displayUrl}`);
      } catch (err) {
        ui.showError(String(err));
        const localIP = getLocalIP();
        connInfo = formatConnectionInfo({ mode: "lan", host: localIP, port });
      }
    } else if (options.tunnel === "localtunnel") {
      ui.showSystem("Starting localtunnel...");
      const tunnelInfo = await startLocaltunnel(port);
      if (tunnelInfo) {
        connInfo = tunnelInfo;
        ui.showSystem(`Tunnel ready: ${connInfo.displayUrl}`);
      } else {
        ui.showError("localtunnel failed — falling back to LAN.");
        const localIP = getLocalIP();
        connInfo = formatConnectionInfo({ mode: "lan", host: localIP, port });
      }
    } else if (options.relay) {
      connInfo = formatConnectionInfo({ mode: "relay", host: options.relay, port: 0 });
      ui.showSystem(`Using relay: ${options.relay}`);
    } else {
      const localIP = getLocalIP();
      connInfo = formatConnectionInfo({ mode: "lan", host: localIP, port });
    }

    ui.showWelcome(session.code, session.password, connInfo.displayUrl);
  } else {
    // Default: LAN WebSocket server
    const localIP = getLocalIP();
    connInfo = formatConnectionInfo({ mode: "lan", host: localIP, port });
    ui.showWelcome(session.code, session.password, connInfo.displayUrl);
  }

  ui.setParticipants(server.getParticipantNames());
  ui.startInputLoop();
  ui.onReplyExpansion(() => lastWhisperer ?? null);
  ui.showHint("Type a message to chat, or @claude <prompt> to ask Claude. /help for commands.");

  const router = new PromptRouter(claude, server, {
    hostUser: options.name,
    approvalMode,
  });

  server.on("prompt", (msg) => {
    debug(`prompt from ${msg.user}: "${msg.text.slice(0, 60)}${msg.text.length > 60 ? "…" : ""}"`);
    ui.showUserPrompt(msg.user, msg.text, "guest", "claude");
    ui.showClaudeThinking();
    router.handlePrompt(msg);
  });

  server.on("chat", (msg) => {
    const isAgentMsg = !!(msg as any).isAgentResponse;
    const msgHops: number = (msg as any).agentHops ?? 0;
    ui.showUserPrompt(msg.user, msg.text, "guest", isAgentMsg ? "agent" as any : "chat");
    if (!isAgentMsg) router.addChatMessage(msg.user, msg.text);

    // Discussion mode: route agent messages to moderation + advance turn
    if (discussionMode && isAgentMsg) {
      resetSilenceTimer();
      advanceTurn(); // next speaker's turn
      if (localClaude) {
        const entry = { sender: msg.user, text: msg.text, hops: msgHops };
        if (!isModerating && !localClaude.isBusy()) {
          processModerationMessage(entry);
        } else {
          pendingModerationMessages.push(entry);
        }
      }
      return;
    }

    // Agent mode: auto-respond to human messages (not agent responses)
    if (agentModeEnabled && localClaude && !localClaude.isBusy() && !isHostAgentTurn && !isAgentMsg && !discussionMode) {
      const now = Date.now();
      if (now - lastAgentResponseTime >= AGENT_RATE_LIMIT_MS) {
        currentIncomingHops = 0;
        isHostAgentTurn = true;
        agentResponseBuffer = "";
        localClaude.sendPrompt(`${msg.user}: ${msg.text}`);
      } else {
        const remaining = Math.ceil((AGENT_RATE_LIMIT_MS - (now - lastAgentResponseTime)) / 1000);
        ui.showSystem(`[agent] Rate limit active — skipping response (${remaining}s remaining)`);
      }
    }
  });

  let messageCount = 0;
  const sessionStartTime = Date.now();

  // Reply tracking — last participant who whispered the host
  let lastWhisperer: string | undefined;

  // Build command context for slash commands
  const cmdCtx: CommandContext = {
    ui,
    role: "host",
    sessionCode: session.code,
    hostName: options.name,
    participantNames: () => server.getParticipantNames(),
    startTime: sessionStartTime,
    onLeave: async () => {
      server.broadcast({
        type: "notice",
        message: "Host ended the session. Goodbye!",
        timestamp: Date.now(),
      });
      const elapsed = Date.now() - sessionStartTime;
      const minutes = Math.floor(elapsed / 60000);
      const seconds = Math.floor((elapsed % 60000) / 1000);
      ui.showSessionSummary({
        duration: `${minutes}m ${seconds}s`,
        messageCount,
        cost: totalCost || undefined,
        resumeSessionId: claudeSessionId,
      });
      connInfo?.cleanup?.();

      await localClaude?.stop();
      await claude.stop();
      await server.stop();
      ui.close();
      process.exit(0);
    },
    onTrustChange: (trusted) => {
      router.setApprovalMode(!trusted);
    },
    onKick: (name: string) => {
      const result = server.kickParticipant(name);
      if (!result) {
        ui.showSystem(`Could not kick "${name}" — not found or is the host.`);
      }
    },
    onAgentModeOff: (name: string) => {
      const result = server.disableAgentMode(name);
      if (!result) {
        ui.showSystem(`Could not disable agent mode for "${name}" — not found or not in agent mode.`);
      }
    },
    onAgentModeToggle: options.withClaude
      ? (enabled) => {
          if (enabled) {
            if (agentModeEnabled) {
              ui.showSystem("Agent mode is already enabled. Use /agent-mode off to disable.");
              return;
            }
            ui.showConfirmation(
              "Enable agent mode? Your local Claude will auto-respond to all chat messages on your behalf.",
              (confirmed) => {
                if (!confirmed) {
                  ui.showSystem("Agent mode not enabled.");
                  return;
                }
                agentModeEnabled = true;
                server.broadcast({
                  type: "notice",
                  message: `${options.name} enabled agent mode`,
                  timestamp: Date.now(),
                });
                ui.showSystem("Agent mode enabled — local Claude will auto-respond to chat messages.");
              },
            );
          } else {
            if (!agentModeEnabled) {
              ui.showSystem("Agent mode is not active.");
              return;
            }
            agentModeEnabled = false;
            isHostAgentTurn = false;
            agentResponseBuffer = "";
            server.broadcast({
              type: "notice",
              message: `${options.name} disabled agent mode`,
              timestamp: Date.now(),
            });
            ui.showSystem("Agent mode disabled.");
          }
        }
      : undefined,
    isAgentMode: options.withClaude ? () => agentModeEnabled : undefined,
    onAgenticDiscussion: (topic) => {
      if (discussionMode) {
        ui.showSystem("An agentic discussion is already in progress.");
        return;
      }
      discussionMode = true;
      discussionTopic = topic;
      firstDiscussionMessage = true;
      pendingModerationMessages.length = 0;

      // Build round-robin turn order from all participants with agent mode
      discussionTurnOrder = buildTurnOrder();
      discussionTurnIndex = 0;

      // Broadcast discussion start (also emits to host via server_message)
      server.broadcast({
        type: "agent_discussion_start",
        topic,
        initiator: options.name,
        seq: 0,
        timestamp: Date.now(),
      });
      ui.showSystem(`[system] Agentic discussion started: "${topic}"`);
      if (discussionTurnOrder.length === 0) {
        ui.showSystem("[system] Warning: no participants have agent mode enabled — discussion may time out.");
      } else {
        ui.showSystem(`[system] Turn order: ${discussionTurnOrder.join(" → ")}`);
        if (!localClaude) {
          ui.showSystem("[system] Host has no local Claude — AI moderation disabled, using silence timeout only.");
        }
      }

      // Broadcast first turn and start silence timer
      broadcastNextTurn();
      resetSilenceTimer();
    },
    isDiscussionActive: () => discussionMode,
    onStopDiscussion: () => {
      stopDiscussion("manual");
    },
    hasActiveAgents: () => {
      // Check if host has agent mode on OR any remote participant has agentMode
      if (agentModeEnabled) return true;
      const registry = server.getRegistry();
      return registry.getRemote().some((p) => p.agentMode);
    },
    onReply: (message) => {
      if (!lastWhisperer) {
        ui.showSystem("No whisper to reply to yet — use @name <message> to start one.");
        return;
      }
      ui.showWhisper("outgoing", options.name, [lastWhisperer], message, "host");
      server.injectLocalMessage({
        type: "whisper",
        id: `host-w-${Date.now()}`,
        targets: [lastWhisperer],
        text: message,
        timestamp: Date.now(),
      });
    },
    getContextMode: () => router.getContextMode(),
    onContextModeChange: (mode) => {
      router.setContextMode(mode);
      const detail = mode === "full"
        ? "your @claude prompts will include team chat history as context"
        : "your @claude prompts will be sent as-is (no chat history)";
      server.broadcast({
        type: "notice",
        message: `Host set context mode to ${mode} — ${detail}`,
        timestamp: Date.now(),
      });
    },
  };

  server.on("participant_joined", async (user: string) => {
    debug(`participant joined: ${user} (total: ${server.getParticipantNames().length})`);
    sessionManager.addGuest(session.code, user);
    ui.setParticipants(server.getParticipantNames());
    ui.showPartnerJoined(user);

    // Notify the joining participant if this is a resumed session
    if (options.continueSession || options.resumeSession) {
      const notice = options.resumeSession
        ? `Host resumed Claude session ${options.resumeSession.slice(0, 8)}…`
        : "Host resumed a previous Claude session";
      server.sendToByName(user, { type: "notice", message: notice, timestamp: Date.now() });
    }

    // Send session history to guest if resuming an existing session
    const claudeSessionId = claude.getSessionId();
    if (claudeSessionId && (options.continueSession || options.resumeSession)) {
      try {
        const sessionDir = getProjectSessionDir();
        const sessionFilePath = join(sessionDir, `${claudeSessionId}.jsonl`);
        const history = await parseSessionHistory(sessionFilePath);
        if (history.length > 0) {
          server.broadcast({
            type: "history_replay",
            messages: history,
            sessionId: claudeSessionId,
            resumedFrom: history.length,
            timestamp: Date.now(),
          });
          ui.showSystem(`Sent ${history.length} history messages to ${user}.`);
        }
      } catch {
        // History replay is best-effort — don't fail the session
        ui.showSystem("Could not load session history for replay.");
      }
    }
  });

  server.on("participant_left", (user: string) => {
    debug(`participant left: ${user} (remaining: ${server.getParticipantNames().length})`);
    ui.setParticipants(server.getParticipantNames());
    ui.showPartnerLeft(user || "participant");
  });

  let typingTimeout: ReturnType<typeof setTimeout> | undefined;
  let currentTyping: { targets: string[] | null } | null = null;

  function sendTypingIndicator(isTyping: boolean, targets: string[] | null): void {
    const msg = { type: "typing_indicator" as const, user: options.name, isTyping, timestamp: Date.now() };
    if (targets === null) {
      server.broadcast(msg as any);
    } else {
      for (const name of targets) server.sendToByName(name, msg as any);
    }
    // targets === [] → suppress, send to nobody
  }

  function stopTyping(): void {
    if (!currentTyping) return;
    sendTypingIndicator(false, currentTyping.targets);
    currentTyping = null;
  }

  ui.onKeystroke(() => {
    const input = ui.getCurrentInput();

    // Slash commands are private — never broadcast typing
    if (input.startsWith("/")) {
      stopTyping();
      return;
    }

    const newTargets = resolveTypingTargets(input, server.getParticipantNames());

    if (currentTyping !== null) {
      const changed = JSON.stringify(currentTyping.targets) !== JSON.stringify(newTargets);
      if (changed) stopTyping();
    }

    if (currentTyping === null && (newTargets === null || newTargets.length > 0)) {
      sendTypingIndicator(true, newTargets);
      currentTyping = { targets: newTargets };
    }

    if (typingTimeout) clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
      stopTyping();
      typingTimeout = undefined;
    }, 2000);
  });

  ui.onInput((text) => {
    if (typingTimeout) clearTimeout(typingTimeout);
    stopTyping();

    messageCount++;

    // Slash commands
    if (handleSlashCommand(text, cmdCtx)) return;

    if (text.toLowerCase().startsWith("@claude ")) {
      // Claude prompt
      const prompt = text.slice(8);
      const msg = {
        type: "prompt" as const,
        id: `host-${Date.now()}`,
        user: options.name,
        text: prompt,
        source: "host" as const,
        timestamp: Date.now(),
      };
      ui.showUserPrompt(options.name, prompt, "host", "claude");
      ui.showClaudeThinking();
      router.handlePrompt(msg);
    } else {
      // Check for whisper (@name message)
      const participantNameList = server.getParticipantNames();
      const whisper = parseWhisper(text, participantNameList);
      if (whisper) {
        ui.showWhisper("outgoing", options.name, whisper.targets, whisper.text, "host");
        server.injectLocalMessage({
          type: "whisper",
          id: `host-w-${Date.now()}`,
          targets: whisper.targets,
          text: whisper.text,
          timestamp: Date.now(),
        });
      } else if (text.startsWith("@") && !text.startsWith("@claude")) {
        // Warn about unknown @name to avoid accidental public messages
        const atMatch = text.match(/^@(\S+)/);
        if (atMatch) {
          ui.showError(`Unknown participant "@${atMatch[1]}". Message not sent. Use /who to see participants.`);
        } else {
          ui.showUserPrompt(options.name, text, "host", "chat");
          server.broadcast({
            type: "chat_received",
            user: options.name,
            text,
            source: "host",
            timestamp: Date.now(),
          });
          router.addChatMessage(options.name, text);
        }
      } else {
        // Chat message — broadcast to all, don't send to Claude
        ui.showUserPrompt(options.name, text, "host", "chat");
        server.broadcast({
          type: "chat_received",
          user: options.name,
          text,
          source: "host",
          timestamp: Date.now(),
        });
        router.addChatMessage(options.name, text);
      }
    }
  });

  ui.onApproval((promptId, approved) => {
    router.handleApproval({ promptId, approved });
    if (!approved) {
      ui.showSystem("Prompt rejected.");
    }
  });

  server.on("server_message", (msg) => {
    if (msg.type === "approval_request") {
      ui.showApprovalRequest(msg.promptId, msg.user, msg.text);
    }
    if (msg.type === "notice") {
      ui.showSystem(msg.message);
    }
    if (msg.type === "typing_indicator") {
      if ((msg as any).user !== options.name) {
        ui.showTypingIndicator((msg as any).user, (msg as any).isTyping);
      }
    }
    if (msg.type === "whisper_received") {
      const w = msg as any;
      // Skip echo of our own outgoing whispers (already shown locally)
      if (w.sender?.name !== options.name) {
        lastWhisperer = w.sender?.name;
        ui.showWhisper("incoming", w.sender?.name, w.targets ?? [], w.text, w.sender?.role ?? "guest");
      }
    }
    if (msg.type === "agent_discussion_start") {
      const disc = msg as any;
      // Only act if host didn't initiate it (host sets discussionMode directly in onAgenticDiscussion)
      if (!discussionMode) {
        discussionMode = true;
        discussionTopic = disc.topic;
        firstDiscussionMessage = true;
        pendingModerationMessages.length = 0;
        discussionTurnOrder = buildTurnOrder();
        discussionTurnIndex = 0;
        ui.showSystem(`[system] Agentic discussion started by ${disc.initiator}: "${disc.topic}"`);
        if (discussionTurnOrder.length === 0) {
          ui.showSystem("[system] Warning: no participants have agent mode enabled — discussion may time out.");
        } else {
          ui.showSystem(`[system] Turn order: ${discussionTurnOrder.join(" → ")}`);
          if (!localClaude) {
            ui.showSystem("[system] Host has no local Claude — AI moderation disabled, using silence timeout only.");
          }
        }
        broadcastNextTurn();
        resetSilenceTimer();
      }
    }
    if (msg.type === "agent_discussion_turn") {
      const turn = msg as any;
      // If it's the host's turn and host has agent mode, auto-respond
      if (turn.speaker === options.name && discussionMode && agentModeEnabled && localClaude && !localClaude.isBusy() && !isHostAgentTurn && !isModerating) {
        currentIncomingHops = 0;
        isHostAgentTurn = true;
        agentResponseBuffer = "";
        localClaude.sendPrompt(`You're in a collaborative coding session discussion about "${discussionTopic}". It's your turn — share your thoughts briefly.`);
      }
    }
    if (msg.type === "agent_chain_stop") {
      // Clean up local state (don't re-broadcast — this IS the broadcast arriving back)
      discussionMode = false;
      isModerating = false;
      moderationBuffer = "";
      pendingModerationMessages.length = 0;
      isHostAgentTurn = false;
      agentResponseBuffer = "";
      discussionTurnOrder = [];
      if (discussionSilenceTimer) { clearTimeout(discussionSilenceTimer); discussionSilenceTimer = undefined; }
    }
  });

  process.on("SIGINT", async () => {
    // Notify guest before shutting down
    server.broadcast({
      type: "notice",
      message: "Host ended the session. Goodbye!",
      timestamp: Date.now(),
    });
    const elapsed = Date.now() - sessionStartTime;
    const minutes = Math.floor(elapsed / 60000);
    const seconds = Math.floor((elapsed % 60000) / 1000);
    ui.showSessionSummary({
      duration: `${minutes}m ${seconds}s`,
      messageCount,
      cost: totalCost || undefined,
      resumeSessionId: claudeSessionId,
    });
    connInfo?.cleanup?.();
    await localClaude?.stop();
    await claude.stop();
    await server.stop();
    ui.close();
    process.exit(0);
  });
}
