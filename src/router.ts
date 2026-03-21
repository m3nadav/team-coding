import type { ClaudeBridge, ClaudeEvent } from "./claude.js";
import type { TeamCodingServer } from "./server.js";
import type { PromptMessage, ServerMessage } from "./protocol.js";

interface RouterOptions {
  hostUser: string;
  approvalMode: boolean;
}

interface PendingPrompt {
  msg: PromptMessage;
  timestamp: number;
}

interface ChatEntry {
  user: string;
  text: string;
}

interface QueuedPrompt {
  msg: PromptMessage;
  isHost: boolean;
}

export class PromptRouter {
  private pending = new Map<string, PendingPrompt>();
  private claude: ClaudeBridge;
  private server: TeamCodingServer;
  private options: RouterOptions;
  private chatHistory: ChatEntry[] = [];
  private lastClaudeResponseIndex = 0;
  private promptQueue: QueuedPrompt[] = [];
  private contextMode: "full" | "prompt-only" = "full";

  constructor(claude: ClaudeBridge, server: TeamCodingServer, options: RouterOptions) {
    this.claude = claude;
    this.server = server;
    this.options = options;

    // Drain prompt queue and advance chat context pointer after each Claude turn
    claude.on("event", (event: ClaudeEvent) => {
      if (event.type === "turn_complete") {
        this.lastClaudeResponseIndex = this.chatHistory.length;
        this.processQueue();
      }
    });
  }

  /**
   * Record a chat message into the context history.
   * Call this whenever a chat message is broadcast (host or participant).
   */
  addChatMessage(user: string, text: string): void {
    this.chatHistory.push({ user, text });
    // Bound to last 500 messages
    if (this.chatHistory.length > 500) {
      this.chatHistory.shift();
      // Clamp index so it doesn't go negative
      if (this.lastClaudeResponseIndex > 0) {
        this.lastClaudeResponseIndex--;
      }
    }
  }

  /**
   * Build a context prefix from chat messages since the last Claude response.
   * Returns empty string if there are no relevant messages.
   */
  private buildContextPrefix(): string {
    const relevant = this.chatHistory.slice(this.lastClaudeResponseIndex);
    if (relevant.length === 0) return "";
    const lines = relevant.map((e) => `${e.user}: ${e.text}`).join("\n");
    return `[Team chat context]\n${lines}\n\n`;
  }

  async handlePrompt(msg: PromptMessage): Promise<void> {
    // Prefer sender.role (server-validated identity) when present; fall back to
    // source for host-originated messages, which are injected locally without a sender.
    const isHost = (msg.sender?.role ?? msg.source) === "host";

    // Broadcast that prompt was received (include source so the sender can skip their own echo)
    this.server.broadcast({
      type: "prompt_received",
      promptId: msg.id,
      user: msg.user,
      text: msg.text,
      source: msg.source,
      sender: msg.sender,
      timestamp: Date.now(),
    });

    if (isHost || !this.options.approvalMode) {
      this.executeOrQueue(msg, isHost);
      return;
    }

    // Queue for approval
    this.pending.set(msg.id, { msg, timestamp: Date.now() });
    this.server.broadcast({
      type: "approval_request",
      promptId: msg.id,
      user: msg.user,
      text: msg.text,
      timestamp: Date.now(),
    });
    this.server.broadcast({
      type: "approval_status",
      promptId: msg.id,
      status: "pending",
      timestamp: Date.now(),
    } as any);
  }

  async handleApproval(response: { promptId: string; approved: boolean }): Promise<void> {
    const pending = this.pending.get(response.promptId);
    if (!pending) return;

    this.pending.delete(response.promptId);

    this.server.broadcast({
      type: "approval_status",
      promptId: response.promptId,
      status: response.approved ? "approved" : "rejected",
      timestamp: Date.now(),
    } as any);

    if (response.approved) {
      this.executeOrQueue(pending.msg, false);
    }
    // If rejected, just discard silently
  }

  private executeOrQueue(msg: PromptMessage, isHost: boolean): void {
    if (this.claude.isBusy()) {
      this.promptQueue.push({ msg, isHost });
      this.server.broadcast({
        type: "notice",
        message: `${msg.user}'s prompt is queued (Claude is busy processing another prompt)`,
        timestamp: Date.now(),
      });
      return;
    }
    this.sendToClaudeWithContext(msg, isHost);
  }

  private sendToClaudeWithContext(msg: PromptMessage, isHost: boolean): void {
    const contextPrefix = this.contextMode === "full" ? this.buildContextPrefix() : "";
    const fullText = contextPrefix
      ? `${contextPrefix}[Prompt from ${msg.user}]\n${msg.text}`
      : msg.text;
    this.claude.sendPrompt(msg.user, fullText, { isHost });
  }

  setContextMode(mode: "full" | "prompt-only"): void {
    this.contextMode = mode;
  }

  getContextMode(): "full" | "prompt-only" {
    return this.contextMode;
  }

  private processQueue(): void {
    if (this.promptQueue.length === 0) return;
    if (this.claude.isBusy()) return;

    const next = this.promptQueue.shift()!;
    this.server.broadcast({
      type: "notice",
      message: `Processing ${next.msg.user}'s queued prompt...`,
      timestamp: Date.now(),
    });
    this.sendToClaudeWithContext(next.msg, next.isHost);
  }

  setApprovalMode(enabled: boolean): void {
    this.options.approvalMode = enabled;
  }
}
