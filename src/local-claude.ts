import { EventEmitter } from "node:events";
import { ClaudeBridge, type ClaudeEvent } from "./claude.js";

// ---------------------------------------------------------------------------
// LocalClaude — private per-participant Claude instance
// ---------------------------------------------------------------------------
// Wraps ClaudeBridge for local-only use. Responses never leave the machine.
// Used by join --with-claude for /think and /private commands.

export interface LocalClaudeOptions {
  cwd?: string;
  continue?: boolean;
  resume?: string;
}

export class LocalClaude extends EventEmitter {
  private bridge: ClaudeBridge;
  private _started = false;

  constructor(options: LocalClaudeOptions = {}) {
    super();
    this.bridge = new ClaudeBridge({
      cwd: options.cwd ?? process.cwd(),
      permissionMode: "auto",
      continue: options.continue,
      resume: options.resume,
    });
  }

  async start(): Promise<void> {
    if (this._started) return;
    this._started = true;

    this.bridge.on("event", (event: ClaudeEvent) => {
      this.emit("event", event);
    });

    await this.bridge.start();
  }

  /**
   * Send a prompt to the local Claude instance.
   * The prompt is raw — it's the participant's private query and is never
   * shared with the server or other participants.
   */
  sendPrompt(text: string): void {
    // Use "you" as the attribution — purely local, never transmitted
    this.bridge.sendPrompt("you", text);
  }

  isBusy(): boolean {
    return this.bridge.isBusy();
  }

  isStarted(): boolean {
    return this._started;
  }

  async stop(): Promise<void> {
    if (!this._started) return;
    await this.bridge.stop();
    this._started = false;
  }
}
