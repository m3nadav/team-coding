import { describe, it, expect, vi, beforeEach } from "vitest";
import { PromptRouter } from "../router.js";
import { ClaudeBridge } from "../claude.js";
import { TeamCodingServer } from "../server.js";
import type { PromptMessage } from "../protocol.js";

// Capture the event listener registered by PromptRouter on ClaudeBridge
let capturedEventHandler: ((event: any) => void) | undefined;
let mockIsBusy = false;

// Mock Claude bridge
vi.mock("../claude.js", () => ({
  ClaudeBridge: vi.fn().mockImplementation(() => ({
    on: vi.fn().mockImplementation((event: string, handler: any) => {
      if (event === "event") capturedEventHandler = handler;
    }),
    emit: vi.fn(),
    sendPrompt: vi.fn().mockReturnValue(undefined),
    formatPrompt: vi.fn((user: string, text: string) => `[${user}]: ${text}`),
    isBusy: vi.fn().mockImplementation(() => mockIsBusy),
  })),
}));

beforeEach(() => {
  capturedEventHandler = undefined;
  mockIsBusy = false;
});

describe("PromptRouter", () => {
  it("routes host prompts directly to Claude", async () => {
    const claude = new ClaudeBridge();
    const server = { broadcast: vi.fn(), on: vi.fn() } as any;

    const router = new PromptRouter(claude, server, { hostUser: "eliran", approvalMode: true });

    const msg: PromptMessage = {
      type: "prompt",
      id: "1",
      user: "eliran",
      text: "fix the bug",
      source: "host",
      timestamp: Date.now(),
    };

    await router.handlePrompt(msg);
    expect(claude.sendPrompt).toHaveBeenCalledWith("eliran", "fix the bug", { isHost: true });
  });

  it("queues guest prompts for approval when approval mode is on", async () => {
    const claude = new ClaudeBridge();
    const server = { broadcast: vi.fn(), on: vi.fn() } as any;

    const router = new PromptRouter(claude, server, { hostUser: "eliran", approvalMode: true });

    const msg: PromptMessage = {
      type: "prompt",
      id: "1",
      user: "benji",
      text: "delete everything",
      source: "participant",
      timestamp: Date.now(),
    };

    await router.handlePrompt(msg);

    // Should NOT call Claude directly
    expect(claude.sendPrompt).not.toHaveBeenCalled();
    // Should broadcast approval request
    expect(server.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "approval_request", user: "benji" })
    );
  });

  it("routes guest prompts directly when approval mode is off", async () => {
    const claude = new ClaudeBridge();
    const server = { broadcast: vi.fn(), on: vi.fn() } as any;

    const router = new PromptRouter(claude, server, { hostUser: "eliran", approvalMode: false });

    const msg: PromptMessage = {
      type: "prompt",
      id: "1",
      user: "benji",
      text: "fix the bug",
      source: "participant",
      timestamp: Date.now(),
    };

    await router.handlePrompt(msg);
    expect(claude.sendPrompt).toHaveBeenCalledWith("benji", "fix the bug", { isHost: false });
  });

  it("executes prompt after approval", async () => {
    const claude = new ClaudeBridge();
    const server = { broadcast: vi.fn(), on: vi.fn() } as any;

    const router = new PromptRouter(claude, server, { hostUser: "eliran", approvalMode: true });

    // Queue a prompt
    const msg: PromptMessage = {
      type: "prompt",
      id: "prompt-1",
      user: "benji",
      text: "fix the bug",
      source: "participant",
      timestamp: Date.now(),
    };
    await router.handlePrompt(msg);

    // Approve it
    await router.handleApproval({ promptId: "prompt-1", approved: true });
    expect(claude.sendPrompt).toHaveBeenCalledWith("benji", "fix the bug", { isHost: false });
  });

  it("discards prompt after rejection", async () => {
    const claude = new ClaudeBridge();
    const server = { broadcast: vi.fn(), on: vi.fn() } as any;

    const router = new PromptRouter(claude, server, { hostUser: "eliran", approvalMode: true });

    const msg: PromptMessage = {
      type: "prompt",
      id: "prompt-1",
      user: "benji",
      text: "delete everything",
      source: "participant",
      timestamp: Date.now(),
    };
    await router.handlePrompt(msg);
    await router.handleApproval({ promptId: "prompt-1", approved: false });

    expect(claude.sendPrompt).not.toHaveBeenCalled();
  });

  it("guest message with host username still requires approval when source is guest", async () => {
    const claude = new ClaudeBridge();
    const server = { broadcast: vi.fn(), on: vi.fn() } as any;

    const router = new PromptRouter(claude, server, { hostUser: "eliran", approvalMode: true });

    const msg: PromptMessage = {
      type: "prompt",
      id: "spoof-1",
      user: "eliran",
      text: "rm -rf /",
      source: "participant",
      timestamp: Date.now(),
    };

    await router.handlePrompt(msg);

    expect(claude.sendPrompt).not.toHaveBeenCalled();
    expect(server.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "approval_request" })
    );
  });

  it("message without source field is treated as guest (requires approval)", async () => {
    const claude = new ClaudeBridge();
    const server = { broadcast: vi.fn(), on: vi.fn() } as any;

    const router = new PromptRouter(claude, server, { hostUser: "eliran", approvalMode: true });

    const msg: PromptMessage = {
      type: "prompt",
      id: "no-source-1",
      user: "eliran",
      text: "fix the bug",
      timestamp: Date.now(),
    };

    await router.handlePrompt(msg);

    expect(claude.sendPrompt).not.toHaveBeenCalled();
    expect(server.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "approval_request" })
    );
  });

  // ---- Phase 3: Prompt queue ----

  it("queues prompt when Claude is busy and notifies", async () => {
    mockIsBusy = true;
    const claude = new ClaudeBridge();
    const server = { broadcast: vi.fn(), on: vi.fn() } as any;

    const router = new PromptRouter(claude, server, { hostUser: "eliran", approvalMode: false });

    const msg: PromptMessage = {
      type: "prompt",
      id: "busy-1",
      user: "alice",
      text: "help me",
      source: "participant",
      timestamp: Date.now(),
    };

    await router.handlePrompt(msg);

    // Should NOT send to Claude while busy
    expect(claude.sendPrompt).not.toHaveBeenCalled();
    // Should broadcast a queued notice
    expect(server.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "notice", message: expect.stringContaining("queued") })
    );
  });

  it("processes queued prompt after turn_complete fires", async () => {
    mockIsBusy = true;
    const claude = new ClaudeBridge();
    const server = { broadcast: vi.fn(), on: vi.fn() } as any;

    const router = new PromptRouter(claude, server, { hostUser: "eliran", approvalMode: false });

    const msg: PromptMessage = {
      type: "prompt",
      id: "q-1",
      user: "alice",
      text: "help me",
      source: "participant",
      timestamp: Date.now(),
    };

    await router.handlePrompt(msg);
    expect(claude.sendPrompt).not.toHaveBeenCalled();

    // Simulate turn_complete: Claude finishes and is no longer busy
    mockIsBusy = false;
    capturedEventHandler?.({ type: "turn_complete", cost: 0.01, durationMs: 500 });

    expect(claude.sendPrompt).toHaveBeenCalledWith("alice", "help me", { isHost: false });
  });

  it("processes prompts FIFO when multiple are queued", async () => {
    mockIsBusy = true;
    const claude = new ClaudeBridge();
    const server = { broadcast: vi.fn(), on: vi.fn() } as any;

    const router = new PromptRouter(claude, server, { hostUser: "eliran", approvalMode: false });

    const msg1: PromptMessage = {
      type: "prompt", id: "q-1", user: "alice", text: "first", source: "participant", timestamp: Date.now(),
    };
    const msg2: PromptMessage = {
      type: "prompt", id: "q-2", user: "bob", text: "second", source: "participant", timestamp: Date.now(),
    };

    await router.handlePrompt(msg1);
    await router.handlePrompt(msg2);
    expect(claude.sendPrompt).not.toHaveBeenCalled();

    // First turn_complete: processes alice's prompt
    mockIsBusy = false;
    capturedEventHandler?.({ type: "turn_complete", cost: 0, durationMs: 100 });
    expect(claude.sendPrompt).toHaveBeenNthCalledWith(1, "alice", "first", { isHost: false });

    // Second turn_complete: processes bob's prompt
    capturedEventHandler?.({ type: "turn_complete", cost: 0, durationMs: 100 });
    expect(claude.sendPrompt).toHaveBeenNthCalledWith(2, "bob", "second", { isHost: false });
  });

  // ---- Phase 3: Conversation context ----

  it("includes team chat context in full mode", async () => {
    const claude = new ClaudeBridge();
    const server = { broadcast: vi.fn(), on: vi.fn() } as any;

    const router = new PromptRouter(claude, server, { hostUser: "eliran", approvalMode: false });

    router.addChatMessage("alice", "the auth module is broken");
    router.addChatMessage("bob", "agreed, token refresh fails");

    router.setContextMode("full");
    const msg: PromptMessage = {
      type: "prompt",
      id: "ctx-1",
      user: "charlie",
      text: "fix the auth module",
      source: "participant",
      timestamp: Date.now(),
    };

    await router.handlePrompt(msg);

    const [, textArg] = (claude.sendPrompt as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(textArg).toContain("[Team chat context]");
    expect(textArg).toContain("alice: the auth module is broken");
    expect(textArg).toContain("bob: agreed, token refresh fails");
    expect(textArg).toContain("[Prompt from charlie]");
    expect(textArg).toContain("fix the auth module");
  });

  it("sends raw prompt in prompt-only mode (no chat context)", async () => {
    const claude = new ClaudeBridge();
    const server = { broadcast: vi.fn(), on: vi.fn() } as any;

    const router = new PromptRouter(claude, server, { hostUser: "eliran", approvalMode: false });

    router.addChatMessage("alice", "some noise");
    router.addChatMessage("bob", "more noise");

    router.setContextMode("prompt-only");
    const msg: PromptMessage = {
      type: "prompt",
      id: "ponly-1",
      user: "charlie",
      text: "fix auth",
      source: "participant",
      timestamp: Date.now(),
    };

    await router.handlePrompt(msg);

    expect(claude.sendPrompt).toHaveBeenCalledWith("charlie", "fix auth", { isHost: false });
  });

  it("omits context when there are no chat messages since last Claude response", async () => {
    const claude = new ClaudeBridge();
    const server = { broadcast: vi.fn(), on: vi.fn() } as any;

    const router = new PromptRouter(claude, server, { hostUser: "eliran", approvalMode: false });

    // No chat messages — context should be empty, prompt passes through unchanged
    router.setContextMode("full");
    const msg: PromptMessage = {
      type: "prompt",
      id: "no-ctx-1",
      user: "alice",
      text: "fix the bug",
      source: "participant",
      timestamp: Date.now(),
    };

    await router.handlePrompt(msg);

    expect(claude.sendPrompt).toHaveBeenCalledWith("alice", "fix the bug", { isHost: false });
  });

  it("excludes chat messages that occurred before the last Claude response", async () => {
    const claude = new ClaudeBridge();
    const server = { broadcast: vi.fn(), on: vi.fn() } as any;

    const router = new PromptRouter(claude, server, { hostUser: "eliran", approvalMode: false });

    // Old chat (will be excluded after turn_complete)
    router.addChatMessage("alice", "old message");

    // First prompt (source: host so it bypasses approval)
    const msg1: PromptMessage = {
      type: "prompt", id: "p1", user: "eliran", text: "initial", source: "host", timestamp: Date.now(),
    };
    await router.handlePrompt(msg1);

    // Simulate turn_complete — advances lastClaudeResponseIndex
    capturedEventHandler?.({ type: "turn_complete", cost: 0, durationMs: 100 });

    // New chat after the response
    router.addChatMessage("bob", "new message after response");

    // Second prompt — should only see the new chat
    router.setContextMode("full");
    const msg2: PromptMessage = {
      type: "prompt", id: "p2", user: "alice", text: "help", source: "participant",
      timestamp: Date.now(),
    };
    await router.handlePrompt(msg2);

    const calls = (claude.sendPrompt as ReturnType<typeof vi.fn>).mock.calls;
    const secondCallText = calls[1][1] as string;
    expect(secondCallText).toContain("new message after response");
    expect(secondCallText).not.toContain("old message");
  });
});
