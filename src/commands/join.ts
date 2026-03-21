import { TeamClaudeClient } from "../client.js";
import { TerminalUI } from "../ui.js";
import { handleSlashCommand, parseWhisper, resolveTypingTargets, type CommandContext } from "./session-commands.js";
import { createAnswer } from "../peer.js";
import { decodeSDP } from "../sdp-codec.js";
import { copyToClipboard } from "../clipboard.js";
import { LocalClaude } from "../local-claude.js";

interface JoinOptions {
  name: string;
  password?: string;
  url?: string;
  withClaude?: boolean;
  debug?: boolean;
}

function makeDebugLogger(enabled: boolean): (msg: string) => void {
  if (!enabled) return () => {};
  return (msg: string) => {
    const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
    process.stderr.write(`[${ts}] [debug] ${msg}\n`);
  };
}

export async function joinCommand(sessionCodeOrOffer: string, options: JoinOptions): Promise<void> {
  const debug = makeDebugLogger(options.debug ?? false);

  // Global safety net: show error clearly before exit instead of a silent crash.
  // These run AFTER the normal handlers, so only fire for genuinely unhandled cases.
  process.on("uncaughtException", (err) => {
    debug(`uncaughtException: ${err.stack ?? err.message}`);
    process.stderr.write(`\n[team-claude] Unexpected error: ${err.message}\n`);
    if (options.debug) process.stderr.write(`${err.stack}\n`);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    debug(`unhandledRejection: ${stack ?? msg}`);
    process.stderr.write(`\n[team-claude] Unhandled error: ${msg}\n`);
    if (options.debug && stack) process.stderr.write(`${stack}\n`);
    process.exit(1);
  });

  debug(`join started name=${options.name} debug=${options.debug} withClaude=${options.withClaude}`);

  const ui = new TerminalUI({ userName: options.name, role: "participant" });

  const client = new TeamClaudeClient();
  client.setDebugLogger(debug);
  let result: Awaited<ReturnType<typeof client.connect>>;
  let peerCleanup: (() => void) | undefined;

  // Detect if the argument is an offer code (base64url) or a session code (cd-xxx)
  const isOfferCode = !sessionCodeOrOffer.startsWith("cd-");

  if (isOfferCode) {
    // P2P mode — decode offer code and create answer
    if (!options.password) {
      ui.showError("--password is required");
      process.exit(1);
    }

    ui.showSystem("Decoding offer code...");

    let sessionCode: string;
    try {
      const decoded = decodeSDP(sessionCodeOrOffer);
      sessionCode = decoded.sessionCode;
    } catch {
      ui.showError("Invalid offer code. Check that you copied it correctly.");
      process.exit(1);
    }

    ui.showSystem("Creating P2P answer...");

    try {
      const answer = await createAnswer(sessionCodeOrOffer);
      peerCleanup = answer.cleanup;

      console.log("");
      console.log(`  Send this answer code to your partner:`);
      console.log("");
      console.log(`  ${answer.answerCode}`);
      console.log("");

      if (copyToClipboard(answer.answerCode)) {
        ui.showSystem("Copied answer code to clipboard!");
      }

      ui.showSystem("Waiting for P2P connection...");

      const transport = await Promise.race([
        answer.transport,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("P2P connection timed out (30s)")), 30000),
        ),
      ]);

      ui.showSystem("P2P connected! Joining session...");

      result = await client.connectTransport(
        transport,
        options.name,
        options.password,
        sessionCode,
      );
    } catch (err) {
      ui.showError(`P2P connection failed: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  } else {
    // WebSocket mode — classic session code + URL
    if (!options.password) {
      ui.showError("--password is required");
      process.exit(1);
    }

    const serverUrl = options.url || await resolveSessionUrl(sessionCodeOrOffer);

    ui.showSystem(`Connecting to ${serverUrl}...`);

    try {
      result = await client.connect(serverUrl, options.name, options.password, sessionCodeOrOffer);
    } catch (err) {
      ui.showError(`Failed to join: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  }

  ui.applySessionBackground();
  ui.showSystem(`Connected! You're in a session with ${result.hostUser}.`);
  if (result.approvalMode) {
    ui.showSystem("Approval mode is ON — host will review your prompts.");
  }

  // Spawn local Claude if requested
  let localClaude: LocalClaude | undefined;
  if (options.withClaude) {
    localClaude = new LocalClaude(process.cwd());
    localClaude.on("event", (event: any) => {
      switch (event.type) {
        case "stream_chunk":
          ui.showLocalClaudeChunk(event.text);
          break;
        case "tool_use":
          // Local tool use — show dimly
          ui.showSystem(`  [local: ${event.tool}]`);
          break;
        case "turn_complete":
          ui.showLocalClaudeTurnComplete(event.cost, event.durationMs);
          break;
        case "error":
          ui.showLocalClaudeError(event.message);
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

  console.log("");
  ui.startInputLoop();
  ui.showHint(
    options.withClaude
      ? "Type a message to chat, @claude <prompt> for shared Claude, /think <prompt> for private Claude."
      : "Type a message to chat, or @claude <prompt> to ask Claude. /help for commands."
  );

  let messageCount = 0;
  const sessionStartTime = Date.now();

  // Local context mode for /think — controls whether chat history is prepended
  let localContextMode: "full" | "prompt-only" = "full";
  const localChatHistory: Array<{ user: string; text: string }> = [];

  function addToLocalChatHistory(user: string, text: string): void {
    localChatHistory.push({ user, text });
    if (localChatHistory.length > 500) localChatHistory.shift();
  }

  function buildLocalContextPrefix(): string {
    if (localChatHistory.length === 0) return "";
    const lines = localChatHistory.map((e) => `${e.user}: ${e.text}`).join("\n");
    return `[Team chat context]\n${lines}\n\n`;
  }

  // Dynamic participant list — initialized from join_accepted, updated on join/leave
  const knownParticipants: Array<{ name: string; role: string }> =
    (result.participants || []).map((p: any) => ({ name: p.name, role: p.role }));
  ui.setParticipants(knownParticipants.map((p) => p.name));

  const cmdCtx: CommandContext = {
    ui,
    role: "participant",
    hostName: result.hostUser,
    participantNames: () => knownParticipants.map((p) => p.name),
    startTime: sessionStartTime,
    onLeave: async () => {
      const elapsed = Date.now() - sessionStartTime;
      const minutes = Math.floor(elapsed / 60000);
      const seconds = Math.floor((elapsed % 60000) / 1000);
      ui.showSessionSummary({
        duration: `${minutes}m ${seconds}s`,
        messageCount,
      });
      peerCleanup?.();
      await localClaude?.stop();
      await client.disconnect();
      ui.close();
      process.exit(0);
    },
    getContextMode: () => localContextMode,
    onContextModeChange: (mode) => {
      localContextMode = mode;
    },
    onThink: options.withClaude
      ? (prompt) => {
          if (!localClaude) {
            ui.showLocalClaudeError("Local Claude failed to start. Check that the claude CLI is available.");
            return;
          }
          if (localClaude.isBusy()) {
            ui.showLocalClaudeError("Local Claude is busy. Wait for the current response to finish.");
            return;
          }
          const contextPrefix = localContextMode === "full" ? buildLocalContextPrefix() : "";
          const fullPrompt = contextPrefix
            ? `${contextPrefix}[Your question]\n${prompt}`
            : prompt;
          localClaude.sendPrompt(fullPrompt);
        }
      : undefined,
  };

  client.on("message", (msg) => {
    switch (msg.type) {
      case "participant_joined": {
        const p = (msg as any).participant;
        if (p && !knownParticipants.find((k) => k.name === p.name)) {
          knownParticipants.push({ name: p.name, role: p.role });
        }
        ui.setParticipants(knownParticipants.map((k) => k.name));
        ui.showPartnerJoined(p.name);
        break;
      }
      case "participant_left": {
        const p = (msg as any).participant;
        const idx = knownParticipants.findIndex((k) => k.name === p.name);
        if (idx !== -1) knownParticipants.splice(idx, 1);
        ui.setParticipants(knownParticipants.map((k) => k.name));
        ui.showPartnerLeft(p.name);
        break;
      }
      case "history_replay": {
        const replay = msg as any;
        ui.showSystem(`Catching up on ${replay.messages.length} messages...`);
        for (const histMsg of replay.messages) {
          if (histMsg.role === "user") {
            const isHostMsg = histMsg.user?.includes("(host)") || histMsg.user === result.hostUser;
            ui.showUserPrompt(histMsg.user || "user", histMsg.text, isHostMsg ? "host" : "guest", "claude");
          } else if (histMsg.role === "assistant") {
            ui.showStreamChunk(histMsg.text);
          } else if (histMsg.role === "tool") {
            ui.showSystem(`  [${histMsg.toolName || "tool"}] ${histMsg.text.slice(0, 100)}`);
          }
        }
        ui.showSystem("Caught up! You're live.");
        break;
      }
      case "chat_received":
        addToLocalChatHistory(msg.user, msg.text);
        // Skip own messages (already shown locally) — compare sender name, not source role
        if ((msg as any).sender?.name === options.name) break;
        ui.showUserPrompt(msg.user, msg.text, msg.source === "host" ? "host" : "guest", "chat");
        break;
      case "prompt_received":
        // Skip own messages (already shown locally when typed)
        if ((msg as any).sender?.name === options.name) break;
        ui.showUserPrompt(msg.user, msg.text, msg.source === "host" ? "host" : "guest", "claude");
        break;
      case "whisper_received": {
        const w = msg as any;
        const fromMe = w.sender?.name === options.name;
        // Skip echo — already shown locally when the message was sent
        if (fromMe) break;
        ui.showSystem(`[whisper from ${w.sender?.name}] ${w.text}`);
        break;
      }
      case "approval_status":
        ui.showApprovalStatus((msg as any).status);
        break;
      case "stream_chunk":
        ui.showStreamChunk(msg.text);
        break;
      case "tool_use":
        ui.showToolUse(msg.tool, msg.input);
        break;
      case "tool_result":
        ui.showToolResult(msg.tool, msg.output);
        break;
      case "turn_complete":
        ui.showTurnComplete(msg.cost, msg.durationMs);
        break;
      case "typing_indicator":
        if ((msg as any).user !== options.name) {
          ui.showTypingIndicator((msg as any).user, (msg as any).isTyping);
        }
        break;
      case "notice":
        ui.showSystem(msg.message);
        break;
      case "error":
        ui.showError(msg.message);
        break;
    }
  });

  let typingTimeout: ReturnType<typeof setTimeout> | undefined;
  // null = not currently typing; otherwise tracks what targets we sent typing:true for
  let currentTyping: { targets: string[] | null } | null = null;

  function stopTyping(): void {
    if (!currentTyping) return;
    client.sendTyping(false, currentTyping.targets ?? undefined);
    currentTyping = null;
  }

  ui.onKeystroke(() => {
    const input = ui.getCurrentInput();
    const newTargets = resolveTypingTargets(input, knownParticipants.map((p) => p.name));

    // If targets changed, stop the current typing before starting a new one
    if (currentTyping !== null) {
      const changed = JSON.stringify(currentTyping.targets) !== JSON.stringify(newTargets);
      if (changed) stopTyping();
    }

    // Send typing:true unless suppressing (empty targets array from unresolved @name)
    if (currentTyping === null && (newTargets === null || newTargets.length > 0)) {
      client.sendTyping(true, newTargets ?? undefined);
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
      // Claude prompt — send to host via sendPrompt
      const prompt = text.slice(8);
      ui.showUserPrompt(options.name, prompt, "guest", "claude");
      client.sendPrompt(prompt);
    } else {
      // Check for whisper (@name message)
      const participantNameList = knownParticipants.map((p) => p.name);
      const whisper = parseWhisper(text, participantNameList);
      if (whisper) {
        ui.showSystem(`[whisper → ${whisper.targets.join(", ")}] ${whisper.text}`);
        client.sendWhisper(whisper.targets, whisper.text);
      } else if (text.startsWith("@") && !text.startsWith("@claude")) {
        // Warn about unknown @name to avoid accidental public messages
        const atMatch = text.match(/^@(\S+)/);
        if (atMatch) {
          ui.showError(`Unknown participant "@${atMatch[1]}". Message not sent. Use /who to see participants.`);
        } else {
          ui.showUserPrompt(options.name, text, "guest", "chat");
          client.sendChat(text);
        }
      } else {
        // Regular chat message
        addToLocalChatHistory(options.name, text);
        ui.showUserPrompt(options.name, text, "guest", "chat");
        client.sendChat(text);
      }
    }
  });

  client.on("disconnected", () => {
    debug("disconnected event received");
    // Cancel any pending typing timeout — the socket is already closed so just
    // clear state without trying to send a typing:false (sendEncrypted silently drops it).
    if (typingTimeout) {
      clearTimeout(typingTimeout);
      typingTimeout = undefined;
    }
    currentTyping = null;
    const elapsed = Date.now() - sessionStartTime;
    const minutes = Math.floor(elapsed / 60000);
    const seconds = Math.floor((elapsed % 60000) / 1000);
    ui.showSessionSummary({
      duration: `${minutes}m ${seconds}s`,
      messageCount,
    });
    ui.showSystem("The host has ended the session.");
    ui.showHint("Tip: Resume this Claude Code session solo with: claude --continue");
    peerCleanup?.();
    localClaude?.stop();
    ui.close();
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    const elapsed = Date.now() - sessionStartTime;
    const minutes = Math.floor(elapsed / 60000);
    const seconds = Math.floor((elapsed % 60000) / 1000);
    ui.showSessionSummary({
      duration: `${minutes}m ${seconds}s`,
      messageCount,
    });
    peerCleanup?.();
    await localClaude?.stop();
    await client.disconnect();
    ui.close();
    process.exit(0);
  });
}

async function resolveSessionUrl(sessionCode: string): Promise<string> {
  throw new Error(
    `Session discovery not available — use --url to connect directly.\n` +
    `  Ask the host for the join command, or run:\n` +
    `  team-claude join ${sessionCode} --password <password> --url ws://<host-ip>:<port>`
  );
}
