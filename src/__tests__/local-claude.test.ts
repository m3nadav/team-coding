import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

// ---------------------------------------------------------------------------
// Mock ClaudeBridge before importing LocalClaude
// ---------------------------------------------------------------------------

const mockBridge = {
  on: vi.fn(),
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  sendPrompt: vi.fn(),
  isBusy: vi.fn().mockReturnValue(false),
  emit: vi.fn(),
};

const MockClaudeBridge = vi.fn().mockImplementation(() => mockBridge);

vi.mock("../claude.js", () => ({
  ClaudeBridge: MockClaudeBridge,
}));

// Import after mock is set up
const { LocalClaude } = await import("../local-claude.js");

// ---------------------------------------------------------------------------

describe("LocalClaude", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBridge.start.mockResolvedValue(undefined);
    mockBridge.stop.mockResolvedValue(undefined);
    mockBridge.isBusy.mockReturnValue(false);
  });

  it("creates a ClaudeBridge with auto permission mode", () => {
    new LocalClaude("/some/cwd");
    expect(MockClaudeBridge).toHaveBeenCalledWith({
      cwd: "/some/cwd",
      permissionMode: "auto",
    });
  });

  it("uses process.cwd() when no cwd provided", () => {
    new LocalClaude();
    expect(MockClaudeBridge).toHaveBeenCalledWith({
      cwd: process.cwd(),
      permissionMode: "auto",
    });
  });

  it("start() calls bridge.start() and registers event listener", async () => {
    const lc = new LocalClaude();
    await lc.start();
    expect(mockBridge.on).toHaveBeenCalledWith("event", expect.any(Function));
    expect(mockBridge.start).toHaveBeenCalledOnce();
  });

  it("start() is idempotent — does not start twice", async () => {
    const lc = new LocalClaude();
    await lc.start();
    await lc.start();
    expect(mockBridge.start).toHaveBeenCalledOnce();
  });

  it("sendPrompt() calls bridge.sendPrompt with 'you' as the user", () => {
    const lc = new LocalClaude();
    lc.sendPrompt("what does this do?");
    expect(mockBridge.sendPrompt).toHaveBeenCalledWith("you", "what does this do?");
  });

  it("isBusy() delegates to bridge.isBusy()", () => {
    const lc = new LocalClaude();
    mockBridge.isBusy.mockReturnValue(true);
    expect(lc.isBusy()).toBe(true);
    mockBridge.isBusy.mockReturnValue(false);
    expect(lc.isBusy()).toBe(false);
  });

  it("isStarted() returns false before start()", () => {
    const lc = new LocalClaude();
    expect(lc.isStarted()).toBe(false);
  });

  it("isStarted() returns true after start()", async () => {
    const lc = new LocalClaude();
    await lc.start();
    expect(lc.isStarted()).toBe(true);
  });

  it("stop() calls bridge.stop() and resets isStarted", async () => {
    const lc = new LocalClaude();
    await lc.start();
    await lc.stop();
    expect(mockBridge.stop).toHaveBeenCalledOnce();
    expect(lc.isStarted()).toBe(false);
  });

  it("stop() is a no-op if not started", async () => {
    const lc = new LocalClaude();
    await lc.stop(); // should not throw
    expect(mockBridge.stop).not.toHaveBeenCalled();
  });

  it("re-emits bridge events to LocalClaude listeners", async () => {
    // Capture the bridge event listener registered in start()
    let bridgeEventListener: ((event: any) => void) | undefined;
    mockBridge.on.mockImplementation((event: string, handler: any) => {
      if (event === "event") bridgeEventListener = handler;
    });

    const lc = new LocalClaude();
    await lc.start();

    const received: any[] = [];
    lc.on("event", (e) => received.push(e));

    // Simulate bridge emitting events
    bridgeEventListener?.({ type: "stream_chunk", text: "hello" });
    bridgeEventListener?.({ type: "turn_complete", cost: 0.001, durationMs: 500 });

    expect(received).toHaveLength(2);
    expect(received[0]).toEqual({ type: "stream_chunk", text: "hello" });
    expect(received[1]).toEqual({ type: "turn_complete", cost: 0.001, durationMs: 500 });
  });
});
