import pc from "picocolors";
import * as readline from "node:readline";
import { pickSessionBackground, applyBackground, restoreBackground, type SessionBackground } from "./terminal-colors.js";

interface TerminalUIOptions {
  userName: string;
  role: "host" | "guest" | "participant";
}

export class TerminalUI {
  private options: TerminalUIOptions;
  private inputHandler?: (text: string) => void;
  private approvalHandler?: (promptId: string, approved: boolean) => void;
  private rl?: readline.Interface;
  private background?: SessionBackground;
  private rawMode = false;
  private lineBuffer = "";
  private rawHandler?: (data: Buffer) => void;
  private keystrokeHandler?: () => void;
  private typingUser?: string;
  private claudeStreaming = false;
  private claudeProcessing = false;
  private cursorPos = 0;
  private participantNames: string[] = [];

  constructor(options: TerminalUIOptions) {
    this.options = options;
  }

  /**
   * Update the list of known participant names for @name autocomplete.
   */
  setParticipants(names: string[]): void {
    this.participantNames = names;
  }

  private sessionText(text: string): string {
    return this.background ? pc.white(text) : pc.dim(text);
  }

  private claudeStar(): string {
    return `\x1b[38;5;208m\u2726\x1b[0m`;
  }

  private showInputPrompt(): void {
    process.stdout.write(pc.gray("\u27e9 "));
  }

  private getSuggestions(): Array<{ trigger: string; completion: string; display: string }> {
    const suggestions: Array<{ trigger: string; completion: string; display: string }> = [
      { trigger: "@", completion: "@claude ", display: "@claude <prompt>" },
      { trigger: "@c", completion: "@claude ", display: "@claude <prompt>" },
      { trigger: "@cl", completion: "@claude ", display: "@claude <prompt>" },
      { trigger: "@cla", completion: "@claude ", display: "@claude <prompt>" },
      { trigger: "@clau", completion: "@claude ", display: "@claude <prompt>" },
      { trigger: "@claud", completion: "@claude ", display: "@claude <prompt>" },
      { trigger: "@claude", completion: "@claude ", display: "@claude <prompt>" },
      { trigger: "/h", completion: "/help", display: "/help" },
      { trigger: "/he", completion: "/help", display: "/help" },
      { trigger: "/hel", completion: "/help", display: "/help" },
      { trigger: "/s", completion: "/status", display: "/status" },
      { trigger: "/st", completion: "/status", display: "/status" },
      { trigger: "/sta", completion: "/status", display: "/status" },
      { trigger: "/stat", completion: "/status", display: "/status" },
      { trigger: "/statu", completion: "/status", display: "/status" },
      { trigger: "/c", completion: "/clear", display: "/clear" },
      { trigger: "/cl", completion: "/clear", display: "/clear" },
      { trigger: "/cle", completion: "/clear", display: "/clear" },
      { trigger: "/clea", completion: "/clear", display: "/clear" },
      { trigger: "/l", completion: "/leave", display: "/leave" },
      { trigger: "/le", completion: "/leave", display: "/leave" },
      { trigger: "/lea", completion: "/leave", display: "/leave" },
      { trigger: "/leav", completion: "/leave", display: "/leave" },
      { trigger: "/w", completion: "/who", display: "/who" },
      { trigger: "/wh", completion: "/who", display: "/who" },
    ];

    if (this.options.role === "host") {
      suggestions.push(
        { trigger: "/t", completion: "/trust", display: "/trust" },
        { trigger: "/tr", completion: "/trust", display: "/trust" },
        { trigger: "/tru", completion: "/trust", display: "/trust" },
        { trigger: "/trus", completion: "/trust", display: "/trust" },
        { trigger: "/a", completion: "/approval", display: "/approval" },
        { trigger: "/ap", completion: "/approval", display: "/approval" },
        { trigger: "/app", completion: "/approval", display: "/approval" },
        { trigger: "/appr", completion: "/approval", display: "/approval" },
        { trigger: "/appro", completion: "/approval", display: "/approval" },
        { trigger: "/approv", completion: "/approval", display: "/approval" },
        { trigger: "/approva", completion: "/approval", display: "/approval" },
        { trigger: "/k", completion: "/kick ", display: "/kick <name>" },
        { trigger: "/ki", completion: "/kick ", display: "/kick <name>" },
        { trigger: "/kic", completion: "/kick ", display: "/kick <name>" },
      );
    }

    // Dynamic @name completions for whispers — exclude self and "claude"
    for (const name of this.participantNames) {
      if (name.toLowerCase() === "claude") continue;
      if (name === this.options.userName) continue;
      const atName = `@${name} `;
      const display = `@${name} <whisper>`;
      // Generate prefix triggers: @, @a, @al, @ali, @alic, @alice
      for (let i = 1; i <= name.length; i++) {
        const trigger = `@${name.slice(0, i).toLowerCase()}`;
        // Don't override @claude completions
        if (trigger.startsWith("@c")) continue;
        suggestions.push({ trigger, completion: atName, display });
      }
    }

    return suggestions;
  }

  private findSuggestion(input: string): { completion: string; ghost: string } | null {
    if (!input) return null;
    const lower = input.toLowerCase();
    const match = this.getSuggestions().find((s) => s.trigger === lower);
    if (!match) return null;
    const ghost = match.completion.slice(input.length);
    if (!ghost) return null;
    return { completion: match.completion, ghost };
  }

  private redrawLine(): void {
    process.stdout.write(`\r\x1b[2K`);
    process.stdout.write(pc.gray("\u27e9 "));
    process.stdout.write(pc.white(this.lineBuffer));

    const suggestion = this.findSuggestion(this.lineBuffer);
    if (suggestion && this.cursorPos === this.lineBuffer.length) {
      process.stdout.write(pc.dim(suggestion.ghost));
      process.stdout.write(`\x1b[${suggestion.ghost.length}D`);
    } else if (this.typingUser && !this.lineBuffer) {
      const indicator = `  ${this.typingUser} is typing...`;
      process.stdout.write(pc.gray(pc.italic(indicator)));
      process.stdout.write(`\x1b[${indicator.length}D`);
    }

    const charsAfterCursor = this.lineBuffer.length - this.cursorPos;
    if (charsAfterCursor > 0) {
      process.stdout.write(`\x1b[${charsAfterCursor}D`);
    }
  }

  private clearInputLine(): void {
    if (!this.rawMode) return;
    process.stdout.write(`\r\x1b[2K`);
  }

  private restoreInputLine(): void {
    if (!this.rawMode || this.claudeProcessing) return;
    this.redrawLine();
  }

  startInputLoop(): void {
    if (this.rawMode) return;

    if (process.stdin.isTTY) {
      this.rawMode = true;
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding("utf8");

      this.showInputPrompt();

      this.rawHandler = (data: Buffer) => {
        const str = data.toString();

        for (let i = 0; i < str.length; i++) {
          const ch = str[i];
          const code = ch.charCodeAt(0);

          // Ctrl+C
          if (code === 3) {
            process.emit("SIGINT" as any);
            return;
          }

          // Ctrl+A — move to start of line
          if (code === 1) {
            this.cursorPos = 0;
            this.redrawLine();
            continue;
          }

          // Ctrl+E — move to end of line
          if (code === 5) {
            this.cursorPos = this.lineBuffer.length;
            this.redrawLine();
            continue;
          }

          // Enter
          if (code === 13 || code === 10) {
            process.stdout.write(`\r\x1b[2K`);
            const trimmed = this.lineBuffer.trim();
            this.lineBuffer = "";
            this.cursorPos = 0;
            if (trimmed && this.inputHandler) {
              this.inputHandler(trimmed);
            }
            this.showInputPrompt();
            continue;
          }

          // Tab → accept suggestion
          if (code === 9) {
            const suggestion = this.findSuggestion(this.lineBuffer);
            if (suggestion) {
              this.lineBuffer = suggestion.completion;
              this.cursorPos = this.lineBuffer.length;
              this.redrawLine();
            }
            continue;
          }

          // Backspace
          if (code === 127 || code === 8) {
            if (this.cursorPos > 0) {
              this.lineBuffer = this.lineBuffer.slice(0, this.cursorPos - 1) + this.lineBuffer.slice(this.cursorPos);
              this.cursorPos--;
              this.redrawLine();
            }
            continue;
          }

          // Escape sequences (arrows, home, end, delete)
          if (code === 27) {
            if (str[i + 1] === "[") {
              const seq = str[i + 2];
              if (seq === "C") {
                // Right arrow — accept suggestion at end, or move cursor
                const suggestion = this.findSuggestion(this.lineBuffer);
                if (suggestion && this.cursorPos === this.lineBuffer.length) {
                  this.lineBuffer = suggestion.completion;
                  this.cursorPos = this.lineBuffer.length;
                } else if (this.cursorPos < this.lineBuffer.length) {
                  this.cursorPos++;
                }
                this.redrawLine();
                i += 2;
              } else if (seq === "D") {
                // Left arrow
                if (this.cursorPos > 0) {
                  this.cursorPos--;
                  this.redrawLine();
                }
                i += 2;
              } else if (seq === "H") {
                // Home
                this.cursorPos = 0;
                this.redrawLine();
                i += 2;
              } else if (seq === "F") {
                // End
                this.cursorPos = this.lineBuffer.length;
                this.redrawLine();
                i += 2;
              } else if (seq === "3" && str[i + 3] === "~") {
                // Delete key
                if (this.cursorPos < this.lineBuffer.length) {
                  this.lineBuffer = this.lineBuffer.slice(0, this.cursorPos) + this.lineBuffer.slice(this.cursorPos + 1);
                  this.redrawLine();
                }
                i += 3;
              } else {
                i += 2;
              }
            }
            continue;
          }

          // Regular printable character
          if (code >= 32) {
            this.lineBuffer = this.lineBuffer.slice(0, this.cursorPos) + ch + this.lineBuffer.slice(this.cursorPos);
            this.cursorPos++;
            this.redrawLine();
            this.keystrokeHandler?.();
          }
        }
      };

      process.stdin.on("data", this.rawHandler as any);
    } else {
      this.rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: "",
      });
      this.rl.on("line", (line) => {
        const trimmed = line.trim();
        if (trimmed && this.inputHandler) {
          this.inputHandler(trimmed);
        }
        this.showInputPrompt();
      });
      this.showInputPrompt();
    }
  }

  simulateInput(text: string): void {
    if (this.inputHandler) this.inputHandler(text);
  }

  simulateApproval(promptId: string, approved: boolean): void {
    if (this.approvalHandler) this.approvalHandler(promptId, approved);
  }

  applySessionBackground(): void {
    if (this.background) return;
    this.background = pickSessionBackground();
    process.stdout.write("\x1b[2J\x1b[H");
    process.stdout.write(applyBackground(this.background));
  }

  showWelcome(sessionCode: string, password: string, connectUrl?: string, joinCmd?: string): void {
    this.applySessionBackground();

    const violet = (s: string) => pc.magenta(s);
    const dim = (s: string) => this.sessionText(s);
    const bar = violet("  \u2502");

    console.log("");
    console.log(violet("  \u250c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510"));
    console.log(`${bar}  ${pc.bold(pc.cyan("\u2726"))} ${pc.bold(pc.white("team-claude"))} ${dim("session started")}${" ".repeat(13)}${violet("\u2502")}`);
    console.log(violet("  \u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518"));
    console.log("");

    if (joinCmd) {
      console.log(`  ${dim("Send your partner this command to join:")}`);
      console.log("");
      console.log(`  ${pc.green("\u25b6")} ${pc.bold(pc.green(joinCmd))}`);
    } else if (connectUrl) {
      const cmd = `npx team-claude join ${sessionCode} --password ${password} --url ${connectUrl}`;
      console.log(`  ${dim("Send your partner this command to join:")}`);
      console.log("");
      console.log(`  ${pc.green("\u25b6")} ${pc.bold(pc.green(cmd))}`);
    } else {
      console.log(`  ${pc.cyan("\u25cf")} Session code  ${pc.bold(pc.white(sessionCode))}`);
      console.log(`  ${pc.cyan("\u25cf")} Password      ${pc.bold(pc.white(password))}`);
      console.log("");
      console.log(`  ${dim("Share these with your partner to join.")}`);
    }

    console.log("");
    console.log(dim("  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500"));
    console.log("");
    this.showInputPrompt();
  }

  showSystem(message: string): void {
    this.clearInputLine();
    console.log(this.sessionText(`  ${message}`));
    this.restoreInputLine();
  }

  showError(message: string): void {
    this.clearInputLine();
    console.error(pc.red(`  Error: ${message}`));
    this.restoreInputLine();
  }

  showUserPrompt(user: string, text: string, role: "host" | "guest" | "participant", mode: "chat" | "claude" = "chat"): void {
    this.clearInputLine();
    const isSelf = role === this.options.role;
    const partnerColor = role === "host" ? pc.cyan : pc.yellow;

    if (isSelf) {
      if (mode === "claude") {
        console.log(`\n${pc.dim("you \u2192 \u2726 Claude:")}`);
      } else {
        console.log(`\n${pc.dim("you:")}`);
      }
    } else {
      if (mode === "claude") {
        console.log(`\n${pc.bold(partnerColor(user))} ${pc.dim("\u2192 \u2726 Claude:")}`);
      } else {
        console.log(`\n${pc.bold(partnerColor(user + ":"))}`);
      }
    }
    console.log(`  ${this.background ? pc.white(text) : text}`);
    console.log("");
    this.restoreInputLine();
  }

  showClaudeThinking(): void {
    this.clearInputLine();
    this.claudeStreaming = false;
    this.claudeProcessing = true;
    console.log(`\n  ${this.claudeStar()} ${pc.dim("Claude is thinking...")}`);
  }

  showApprovalStatus(status: "pending" | "approved" | "rejected"): void {
    this.clearInputLine();
    switch (status) {
      case "pending":
        console.log(this.sessionText("  \u23f3 Waiting for host to approve..."));
        break;
      case "approved":
        console.log(pc.green("  \u2705 Approved \u2014 Claude is working..."));
        break;
      case "rejected":
        console.log(pc.red("  \u274c Host rejected your prompt"));
        break;
    }
    this.restoreInputLine();
  }

  showHint(text: string): void {
    this.clearInputLine();
    console.log(pc.gray(pc.italic(`  ${text}`)));
    this.restoreInputLine();
  }

  showSessionSummary(summary: { duration: string; messageCount: number; cost?: number }): void {
    this.clearInputLine();
    console.log("");
    console.log(pc.bold(`  ${this.claudeStar()} Session ended`));
    console.log(this.sessionText(`  Duration: ${summary.duration}`));
    console.log(this.sessionText(`  Messages: ${summary.messageCount}`));
    if (summary.cost !== undefined && summary.cost > 0) {
      console.log(this.sessionText(`  Cost: $${summary.cost.toFixed(4)}`));
    }
    console.log("");
  }

  showStreamChunk(text: string): void {
    if (!this.claudeStreaming) {
      this.clearInputLine();
      this.claudeStreaming = true;
      process.stdout.write(`\n  ${this.claudeStar()} ${pc.bold("\x1b[38;5;208mClaude\x1b[0m")}\n`);
    }
    process.stdout.write(text);
  }

  showToolUse(tool: string, _input: Record<string, unknown>): void {
    this.clearInputLine();
    console.log(pc.dim(`  \x1b[38;5;208m\u25b8\x1b[0m ${pc.dim(tool)}`));
  }

  showToolResult(tool: string, output: string): void {
    this.clearInputLine();
    console.log(pc.dim(`  \x1b[38;5;208m\u25c2\x1b[0m ${pc.dim(`${tool}: ${output.slice(0, 100)}`)}`));
  }

  showTurnComplete(cost: number, durationMs: number): void {
    this.clearInputLine();
    this.claudeStreaming = false;
    this.claudeProcessing = false;
    console.log(pc.dim(`\n  ${this.claudeStar()} $${cost.toFixed(4)} \u00b7 ${(durationMs / 1000).toFixed(1)}s`));
    this.restoreInputLine();
  }

  showPartnerJoined(user: string): void {
    this.clearInputLine();
    console.log(pc.green(`\n  \u2726 ${user} joined the session`));
    this.restoreInputLine();
  }

  showPartnerLeft(user: string): void {
    this.clearInputLine();
    console.log(pc.yellow(`\n  \u2726 ${user} left the session`));
    this.restoreInputLine();
  }

  showApprovalRequest(promptId: string, user: string, text: string): void {
    this.clearInputLine();
    console.log("");
    console.log(pc.yellow(`  \u250c\u2500 ${user} \u2192 Claude ${"\u2500".repeat(Math.max(0, 35 - user.length))}\u2510`));
    console.log(pc.yellow(`  \u2502  "${text.length > 40 ? text.slice(0, 37) + "..." : text}"${" ".repeat(Math.max(0, 40 - Math.min(text.length, 40)))}\u2502`));
    console.log(pc.yellow(`  \u2502  ${pc.bold("[y]")} approve  ${pc.bold("[n]")} reject${" ".repeat(22)}\u2502`));
    console.log(pc.yellow(`  \u2514${"\u2500".repeat(44)}\u2518`));

    if (process.stdin.isTTY) {
      if (this.rawMode && this.rawHandler) {
        process.stdin.removeListener("data", this.rawHandler as any);
      } else {
        this.rl?.pause();
        process.stdin.setRawMode(true);
        process.stdin.resume();
      }

      const handler = (data: Buffer) => {
        const key = data.toString().toLowerCase();
        process.stdin.removeListener("data", handler);

        if (this.rawMode && this.rawHandler) {
          process.stdin.on("data", this.rawHandler as any);
          this.showInputPrompt();
        } else {
          process.stdin.setRawMode(false);
          this.rl?.resume();
        }

        if (key === "y") {
          console.log(pc.green("  \u2705 Approved"));
          if (this.approvalHandler) this.approvalHandler(promptId, true);
        } else {
          console.log(pc.red("  \u274c Rejected"));
          if (this.approvalHandler) this.approvalHandler(promptId, false);
        }
      };
      process.stdin.on("data", handler);
    } else {
      if (this.approvalHandler) this.approvalHandler(promptId, true);
    }
  }

  showTypingIndicator(user: string, isTyping: boolean): void {
    if (isTyping) {
      this.typingUser = user;
    } else if (this.typingUser === user) {
      this.typingUser = undefined;
    }
    if (this.rawMode) {
      this.redrawLine();
    }
  }

  clearTypingIndicator(): void {
    this.typingUser = undefined;
    if (this.rawMode) {
      this.redrawLine();
    }
  }

  onKeystroke(handler: () => void): void {
    this.keystrokeHandler = handler;
  }

  onInput(handler: (text: string) => void): void {
    this.inputHandler = handler;
  }

  onApproval(handler: (promptId: string, approved: boolean) => void): void {
    this.approvalHandler = handler;
  }

  close(): void {
    if (this.rawMode && this.rawHandler) {
      process.stdin.removeListener("data", this.rawHandler as any);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      this.rawMode = false;
      this.rawHandler = undefined;
    }
    this.rl?.close();
    this.rl = undefined;
    if (this.background) {
      process.stdout.write(restoreBackground());
      this.background = undefined;
    }
  }
}
