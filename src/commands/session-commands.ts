import type { TerminalUI } from "../ui.js";

export interface CommandContext {
  ui: TerminalUI;
  role: "host" | "participant";
  sessionCode?: string;
  hostName?: string;
  participantNames?: () => string[];
  startTime?: number;
  onLeave: () => void;
  onTrustChange?: (enabled: boolean) => void;
  onKick?: (name: string) => void;
  onAgentModeOff?: (name: string) => void;
  onContextModeChange?: (mode: "full" | "prompt-only") => void;
  getContextMode?: () => "full" | "prompt-only";
  onThink?: (prompt: string) => void;
  onAgentModeToggle?: (enabled: boolean) => void;
  isAgentMode?: () => boolean;
  getLocalSessionId?: () => string | undefined;
  onReply?: (message: string) => void;
}

/**
 * Handle a slash command. Returns true if the input was a recognized command,
 * false if it's not a slash command (should be processed normally).
 */
export function handleSlashCommand(input: string, ctx: CommandContext): boolean {
  if (!input.startsWith("/")) return false;

  const parts = input.slice(1).split(/\s+/);
  const cmd = parts[0]?.toLowerCase();

  switch (cmd) {
    case "help":
      showHelp(ctx);
      return true;

    case "leave":
    case "quit":
    case "exit":
      ctx.ui.showSystem("Leaving session...");
      ctx.onLeave();
      return true;

    case "status":
      showStatus(ctx);
      return true;

    case "who":
      showWho(ctx);
      return true;

    case "clear":
      // Clear screen but keep background
      process.stdout.write("\x1b[2J\x1b[H");
      return true;

    case "trust":
      if (ctx.role !== "host") {
        ctx.ui.showSystem("Only the host can change trust mode.");
        return true;
      }
      ctx.onTrustChange?.(true);
      ctx.ui.showSystem("Switched to trust mode — participant prompts execute without approval.");
      return true;

    case "approval":
      if (ctx.role !== "host") {
        ctx.ui.showSystem("Only the host can change approval mode.");
        return true;
      }
      ctx.onTrustChange?.(false);
      ctx.ui.showSystem("Switched to approval mode — you'll review participant prompts.");
      return true;

    case "kick": {
      if (ctx.role !== "host") {
        ctx.ui.showSystem("Only the host can kick participants.");
        return true;
      }
      const targetName = parts[1];
      if (!targetName) {
        ctx.ui.showSystem("Usage: /kick <name>");
        return true;
      }
      ctx.ui.showSystem(`Disconnecting ${targetName}...`);
      ctx.onKick?.(targetName);
      return true;
    }

    case "agent-mode": {
      // Host remote disable: /agent-mode off <name>
      if (parts[1]?.toLowerCase() === "off" && parts[2] && ctx.role === "host") {
        ctx.onAgentModeOff?.(parts[2]);
        return true;
      }
      // Self-toggle requires --with-claude
      if (!ctx.onAgentModeToggle) {
        ctx.ui.showSystem("Agent mode is only available when running with --with-claude.");
        return true;
      }
      const wantOff = parts[1]?.toLowerCase() === "off";
      ctx.onAgentModeToggle(wantOff ? false : true);
      return true;
    }

    case "context-mode": {
      if (ctx.role !== "host" && !ctx.onThink) {
        ctx.ui.showSystem("Context mode is only available when running with --with-claude.");
        return true;
      }
      const mode = parts[1]?.toLowerCase();
      if (!mode) {
        // No argument — show current mode with selection indicator
        const current = ctx.getContextMode?.() ?? "full";
        const mark = (m: string) => m === current ? `[${m}] ✓` : m;
        const target = ctx.role === "host" ? "shared Claude" : "your local Claude (/think)";
        ctx.ui.showSystem(`Context mode for ${target}: ${mark("full")} | ${mark("prompt-only")}`);
        return true;
      }
      if (mode !== "full" && mode !== "prompt-only") {
        ctx.ui.showSystem("Usage: /context-mode full|prompt-only");
        return true;
      }
      ctx.onContextModeChange?.(mode as "full" | "prompt-only");
      const target = ctx.role === "host" ? "shared Claude" : "your local Claude (/think)";
      ctx.ui.showSystem(`Context mode set to: ${mode} — ${target} will ${mode === "full" ? "include" : "skip"} team chat context`);
      return true;
    }

    case "think":
    case "private": {
      const prompt = parts.slice(1).join(" ").trim();
      if (!prompt) {
        ctx.ui.showSystem(`Usage: /${cmd} <prompt>`);
        return true;
      }
      if (!ctx.onThink) {
        ctx.ui.showSystem("Local Claude is not available. Join with --with-claude to enable /think.");
        return true;
      }
      ctx.onThink(prompt);
      return true;
    }

    case "reply":
    case "r": {
      const message = parts.slice(1).join(" ").trim();
      if (!message) {
        ctx.ui.showSystem("Usage: /reply <message>");
        return true;
      }
      if (!ctx.onReply) {
        ctx.ui.showSystem("No whisper to reply to yet — use @name <message> to start one.");
        return true;
      }
      ctx.onReply(message);
      return true;
    }

    case "session": {
      if (!ctx.getLocalSessionId) {
        ctx.ui.showSystem("No local Claude active. Join with --with-claude to start one.");
        return true;
      }
      const sid = ctx.getLocalSessionId();
      if (!sid) {
        ctx.ui.showSystem("Local Claude session not yet initialized.");
        return true;
      }
      ctx.ui.showSystem(`Local Claude session: ${sid.slice(0, 8)}…`);
      return true;
    }

    default:
      ctx.ui.showSystem(`Unknown command: /${cmd}. Type /help for available commands.`);
      return true;
  }
}

/**
 * Determine typing indicator routing from the current input buffer.
 *
 * Returns:
 *   null        → broadcast (normal message or @claude prompt)
 *   []          → suppress  (starts with @ but target not yet resolved)
 *   string[]    → targeted  (whisper — send only to these participant names)
 */
export function resolveTypingTargets(input: string, participantNames: string[]): string[] | null {
  if (!input.startsWith("@")) return null;
  if (input.toLowerCase().startsWith("@claude")) return null;

  const targets: string[] = [];
  let remaining = input;

  while (remaining.startsWith("@")) {
    const match = remaining.match(/^@(\S+)/);
    if (!match) break;
    const name = match[1];
    const found = participantNames.find((n) => n.toLowerCase() === name.toLowerCase());
    if (!found) break; // partial or unknown name — stop resolving
    targets.push(found);
    remaining = remaining.slice(match[0].length).trimStart();
    if (remaining && !remaining.startsWith("@")) break;
  }

  return targets.length > 0 ? targets : []; // [] = suppress
}

/**
 * Parse input text for whisper syntax: @name1 @name2 message
 * Returns null if not a whisper (no @name prefix, or @claude prefix).
 */
export function parseWhisper(
  input: string,
  participantNames: string[],
): { targets: string[]; text: string } | null {
  if (!input.startsWith("@")) return null;

  const targets: string[] = [];
  let remaining = input;

  while (remaining.startsWith("@")) {
    const match = remaining.match(/^@(\S+)\s*/);
    if (!match) break;

    const name = match[1];

    // @claude is not a whisper — it's a Claude prompt
    if (name.toLowerCase() === "claude") return null;

    // Only treat as whisper target if the name matches a known participant
    if (!participantNames.some((n) => n.toLowerCase() === name.toLowerCase())) {
      break;
    }

    targets.push(name);
    remaining = remaining.slice(match[0].length);
  }

  if (targets.length === 0) return null;

  const text = remaining.trim();
  if (!text) return null; // @name with no message

  return { targets, text };
}

function showHelp(ctx: CommandContext): void {
  const ui = ctx.ui;
  ui.showSystem("");
  ui.showSystem("Available commands:");
  ui.showSystem("  /help           — Show this help");
  ui.showSystem("  /status         — Show session info");
  ui.showSystem("  /who            — List all participants");
  ui.showSystem("  /clear          — Clear the terminal");
  ui.showSystem("  /leave          — Leave the session");
  ui.showSystem("  /reply <msg>    — Reply to the last participant who whispered you");
  if (ctx.role === "host") {
    ui.showSystem("");
    ui.showSystem("Host commands:");
    ui.showSystem("  /trust          — Disable approval (trust participants)");
    ui.showSystem("  /approval       — Enable approval mode");
    ui.showSystem("  /kick <name>    — Disconnect a participant");
    ui.showSystem("  /agent-mode off <name> — Disable a participant's agent mode");
  }
  ui.showSystem("");
  if (ctx.role === "host") {
    ui.showSystem("  /context-mode <full|prompt-only> — Include/skip team chat context in shared Claude prompts");
  } else if (ctx.onThink) {
    ui.showSystem("  /context-mode <full|prompt-only> — Include/skip team chat context in your /think prompts");
    ui.showSystem("  /think <prompt>   — Ask your private local Claude (never shared)");
    ui.showSystem("  /private <prompt> — Alias for /think");
    ui.showSystem("  /agent-mode       — Auto-forward group chat to your local Claude and post its responses");
    ui.showSystem("  /agent-mode off   — Disable agent mode");
    ui.showSystem("  /session          — Show local Claude session ID and resume status");
  }
  ui.showSystem("");
  ui.showSystem("Message prefixes:");
  ui.showSystem("  @claude <msg>     — Send prompt to shared Claude");
  ui.showSystem("  @name <msg>       — Whisper to a specific participant");
  ui.showSystem("  (no prefix)       — Chat with everyone");
  ui.showSystem("");
}

function showStatus(ctx: CommandContext): void {
  const ui = ctx.ui;
  const names = ctx.participantNames?.() ?? [];
  ui.showSystem("");
  ui.showSystem("Session status:");
  if (ctx.sessionCode) {
    ui.showSystem(`  Session: ${ctx.sessionCode}`);
  }
  ui.showSystem(`  Role: ${ctx.role}`);
  ui.showSystem(`  Participants: ${names.length} (${names.join(", ") || "none"})`);
  if (ctx.startTime) {
    const elapsed = Date.now() - ctx.startTime;
    const minutes = Math.floor(elapsed / 60000);
    const seconds = Math.floor((elapsed % 60000) / 1000);
    ui.showSystem(`  Duration: ${minutes}m ${seconds}s`);
  }
  ui.showSystem("");
}

function showWho(ctx: CommandContext): void {
  const ui = ctx.ui;
  const names = ctx.participantNames?.() ?? [];
  ui.showSystem("");
  ui.showSystem("Participants:");
  if (names.length === 0) {
    ui.showSystem("  (no participants)");
  } else {
    for (const name of names) {
      const label = name === ctx.hostName ? " (host)" : "";
      ui.showSystem(`  • ${name}${label}`);
    }
  }
  ui.showSystem("");
}
