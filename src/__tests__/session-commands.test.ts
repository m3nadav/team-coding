import { describe, it, expect, vi } from "vitest";
import { handleSlashCommand, parseWhisper, resolveTypingTargets, type CommandContext } from "../commands/session-commands.js";

function createMockContext(overrides?: Partial<CommandContext>): CommandContext {
  return {
    ui: {
      showSystem: vi.fn(),
      showError: vi.fn(),
    } as any,
    role: "host",
    sessionCode: "cd-test123",
    hostName: "host",
    participantNames: () => ["host", "alice", "bob"],
    startTime: Date.now() - 120000, // 2 minutes ago
    onLeave: vi.fn(),
    onTrustChange: vi.fn(),
    onKick: vi.fn(),
    onAgentModeOff: vi.fn(),
    ...overrides,
  };
}

describe("session commands", () => {
  it("returns false for non-slash input", () => {
    const ctx = createMockContext();
    expect(handleSlashCommand("hello", ctx)).toBe(false);
    expect(handleSlashCommand("@claude help", ctx)).toBe(false);
  });

  it("/help shows available commands", () => {
    const ctx = createMockContext();
    expect(handleSlashCommand("/help", ctx)).toBe(true);
    const calls = (ctx.ui.showSystem as any).mock.calls.map((c: any[]) => c[0]).join("\n");
    expect(calls).toContain("/help");
    expect(calls).toContain("/status");
    expect(calls).toContain("/who");
    expect(calls).toContain("/leave");
    expect(calls).toContain("@claude");
    expect(calls).toContain("@name");
  });

  it("/help shows host-only commands for host", () => {
    const ctx = createMockContext({ role: "host" });
    handleSlashCommand("/help", ctx);
    const calls = (ctx.ui.showSystem as any).mock.calls.map((c: any[]) => c[0]).join("\n");
    expect(calls).toContain("/trust");
    expect(calls).toContain("/kick");
    expect(calls).toContain("/agent-mode off");
  });

  it("/help hides host-only commands for participant", () => {
    const ctx = createMockContext({ role: "participant" });
    handleSlashCommand("/help", ctx);
    const calls = (ctx.ui.showSystem as any).mock.calls.map((c: any[]) => c[0]).join("\n");
    expect(calls).not.toContain("/trust");
    expect(calls).not.toContain("/kick");
  });

  it("/leave calls onLeave", () => {
    const ctx = createMockContext();
    expect(handleSlashCommand("/leave", ctx)).toBe(true);
    expect(ctx.onLeave).toHaveBeenCalled();
  });

  it("/quit and /exit also call onLeave", () => {
    const ctx1 = createMockContext();
    handleSlashCommand("/quit", ctx1);
    expect(ctx1.onLeave).toHaveBeenCalled();

    const ctx2 = createMockContext();
    handleSlashCommand("/exit", ctx2);
    expect(ctx2.onLeave).toHaveBeenCalled();
  });

  it("/status shows session info with participant list", () => {
    const ctx = createMockContext();
    handleSlashCommand("/status", ctx);
    const calls = (ctx.ui.showSystem as any).mock.calls.map((c: any[]) => c[0]).join("\n");
    expect(calls).toContain("cd-test123");
    expect(calls).toContain("host");
    expect(calls).toContain("alice");
    expect(calls).toContain("bob");
    expect(calls).toContain("2m");
  });

  it("/who lists all participants", () => {
    const ctx = createMockContext();
    handleSlashCommand("/who", ctx);
    const calls = (ctx.ui.showSystem as any).mock.calls.map((c: any[]) => c[0]).join("\n");
    expect(calls).toContain("host");
    expect(calls).toContain("alice");
    expect(calls).toContain("bob");
  });

  it("/trust only works for host", () => {
    const participantCtx = createMockContext({ role: "participant" });
    handleSlashCommand("/trust", participantCtx);
    expect(participantCtx.onTrustChange).not.toHaveBeenCalled();

    const hostCtx = createMockContext({ role: "host" });
    handleSlashCommand("/trust", hostCtx);
    expect(hostCtx.onTrustChange).toHaveBeenCalledWith(true);
  });

  it("/approval only works for host", () => {
    const participantCtx = createMockContext({ role: "participant" });
    handleSlashCommand("/approval", participantCtx);
    expect(participantCtx.onTrustChange).not.toHaveBeenCalled();

    const hostCtx = createMockContext({ role: "host" });
    handleSlashCommand("/approval", hostCtx);
    expect(hostCtx.onTrustChange).toHaveBeenCalledWith(false);
  });

  it("/kick requires name argument", () => {
    const ctx = createMockContext();
    handleSlashCommand("/kick", ctx);
    expect(ctx.onKick).not.toHaveBeenCalled();
    const calls = (ctx.ui.showSystem as any).mock.calls.map((c: any[]) => c[0]).join("\n");
    expect(calls).toContain("Usage: /kick <name>");
  });

  it("/kick <name> calls onKick with name", () => {
    const ctx = createMockContext();
    handleSlashCommand("/kick alice", ctx);
    expect(ctx.onKick).toHaveBeenCalledWith("alice");
  });

  it("/kick only works for host", () => {
    const participantCtx = createMockContext({ role: "participant" });
    handleSlashCommand("/kick alice", participantCtx);
    expect(participantCtx.onKick).not.toHaveBeenCalled();
  });

  it("/agent-mode off <name> calls onAgentModeOff for host", () => {
    const ctx = createMockContext({ role: "host" });
    handleSlashCommand("/agent-mode off alice", ctx);
    expect(ctx.onAgentModeOff).toHaveBeenCalledWith("alice");
  });

  describe("/agent-mode self-toggle", () => {
    it("without --with-claude shows 'only available with --with-claude' message", () => {
      const ctx = createMockContext({ role: "participant", onAgentModeToggle: undefined });
      expect(handleSlashCommand("/agent-mode", ctx)).toBe(true);
      const out = (ctx.ui.showSystem as any).mock.calls.map((c: any[]) => c[0]).join("\n");
      expect(out).toContain("--with-claude");
    });

    it("calls onAgentModeToggle(true) for enable", () => {
      const onAgentModeToggle = vi.fn();
      const ctx = createMockContext({ role: "participant", onAgentModeToggle });
      expect(handleSlashCommand("/agent-mode", ctx)).toBe(true);
      expect(onAgentModeToggle).toHaveBeenCalledWith(true);
    });

    it("calls onAgentModeToggle(false) for /agent-mode off", () => {
      const onAgentModeToggle = vi.fn();
      const ctx = createMockContext({ role: "participant", onAgentModeToggle });
      expect(handleSlashCommand("/agent-mode off", ctx)).toBe(true);
      expect(onAgentModeToggle).toHaveBeenCalledWith(false);
    });

    it("host /agent-mode off <name> uses onAgentModeOff, not onAgentModeToggle", () => {
      const onAgentModeToggle = vi.fn();
      const ctx = createMockContext({ role: "host", onAgentModeToggle, onAgentModeOff: vi.fn() });
      handleSlashCommand("/agent-mode off alice", ctx);
      expect(onAgentModeToggle).not.toHaveBeenCalled();
      expect(ctx.onAgentModeOff).toHaveBeenCalledWith("alice");
    });

    it("/help shows /agent-mode for participant with onThink and onAgentModeToggle", () => {
      const ctx = createMockContext({ role: "participant", onThink: vi.fn(), onAgentModeToggle: vi.fn() });
      handleSlashCommand("/help", ctx);
      const out = (ctx.ui.showSystem as any).mock.calls.map((c: any[]) => c[0]).join("\n");
      expect(out).toContain("/agent-mode");
    });

    it("/help hides /agent-mode for participant without onThink", () => {
      const ctx = createMockContext({ role: "participant", onThink: undefined });
      handleSlashCommand("/help", ctx);
      const out = (ctx.ui.showSystem as any).mock.calls.map((c: any[]) => c[0]).join("\n");
      expect(out).not.toContain("/agent-mode       —");
    });
  });

  it("/clear writes clear screen escape", () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const ctx = createMockContext();
    handleSlashCommand("/clear", ctx);
    const output = writeSpy.mock.calls.map((c: any[]) => String(c[0])).join("");
    expect(output).toContain("\x1b[2J");
    writeSpy.mockRestore();
  });

  it("unknown command shows error message", () => {
    const ctx = createMockContext();
    handleSlashCommand("/foobar", ctx);
    const calls = (ctx.ui.showSystem as any).mock.calls.map((c: any[]) => c[0]).join("\n");
    expect(calls).toContain("Unknown command");
    expect(calls).toContain("/foobar");
  });

  describe("/context-mode", () => {
    it("host: sets mode and confirms it controls shared Claude", () => {
      const onContextModeChange = vi.fn();
      const ctx = createMockContext({ role: "host", onContextModeChange });
      handleSlashCommand("/context-mode full", ctx);
      expect(onContextModeChange).toHaveBeenCalledWith("full");
      const out = (ctx.ui.showSystem as any).mock.calls.map((c: any[]) => c[0]).join("\n");
      expect(out).toContain("shared Claude");
      expect(out).toContain("include");
    });

    it("host: prompt-only says skip", () => {
      const onContextModeChange = vi.fn();
      const ctx = createMockContext({ role: "host", onContextModeChange });
      handleSlashCommand("/context-mode prompt-only", ctx);
      const out = (ctx.ui.showSystem as any).mock.calls.map((c: any[]) => c[0]).join("\n");
      expect(out).toContain("skip");
    });

    it("participant with onThink: sets mode and confirms it controls local Claude", () => {
      const onContextModeChange = vi.fn();
      const ctx = createMockContext({ role: "participant", onContextModeChange, onThink: vi.fn() });
      handleSlashCommand("/context-mode full", ctx);
      expect(onContextModeChange).toHaveBeenCalledWith("full");
      const out = (ctx.ui.showSystem as any).mock.calls.map((c: any[]) => c[0]).join("\n");
      expect(out).toContain("local Claude");
    });

    it("participant without onThink: shows --with-claude message, does not call onContextModeChange", () => {
      const onContextModeChange = vi.fn();
      const ctx = createMockContext({ role: "participant", onContextModeChange, onThink: undefined });
      handleSlashCommand("/context-mode full", ctx);
      expect(onContextModeChange).not.toHaveBeenCalled();
      const out = (ctx.ui.showSystem as any).mock.calls.map((c: any[]) => c[0]).join("\n");
      expect(out).toContain("--with-claude");
    });

    it("no argument shows current mode with ✓ marker on active option (host)", () => {
      const ctx = createMockContext({ role: "host", getContextMode: () => "full" });
      handleSlashCommand("/context-mode", ctx);
      const out = (ctx.ui.showSystem as any).mock.calls.map((c: any[]) => c[0]).join("\n");
      expect(out).toContain("[full] ✓");
      expect(out).toContain("prompt-only");
      expect(out).not.toContain("[prompt-only]");
    });

    it("no argument shows current mode with ✓ on prompt-only when active", () => {
      const ctx = createMockContext({ role: "host", getContextMode: () => "prompt-only" });
      handleSlashCommand("/context-mode", ctx);
      const out = (ctx.ui.showSystem as any).mock.calls.map((c: any[]) => c[0]).join("\n");
      expect(out).toContain("[prompt-only] ✓");
      expect(out).not.toContain("[full]");
    });

    it("no argument defaults to full when getContextMode not wired", () => {
      const ctx = createMockContext({ role: "host" });
      handleSlashCommand("/context-mode", ctx);
      const out = (ctx.ui.showSystem as any).mock.calls.map((c: any[]) => c[0]).join("\n");
      expect(out).toContain("[full] ✓");
    });

    it("invalid value shows usage", () => {
      const ctx = createMockContext({ role: "host" });
      handleSlashCommand("/context-mode invalid", ctx);
      const out = (ctx.ui.showSystem as any).mock.calls.map((c: any[]) => c[0]).join("\n");
      expect(out).toContain("Usage:");
    });

    it("/help shows context-mode for host with 'shared Claude' description", () => {
      const ctx = createMockContext({ role: "host" });
      handleSlashCommand("/help", ctx);
      const out = (ctx.ui.showSystem as any).mock.calls.map((c: any[]) => c[0]).join("\n");
      expect(out).toContain("/context-mode");
      expect(out).toContain("shared Claude");
    });

    it("/help shows context-mode for participant with onThink, mentions local Claude", () => {
      const ctx = createMockContext({ role: "participant", onThink: vi.fn() });
      handleSlashCommand("/help", ctx);
      const out = (ctx.ui.showSystem as any).mock.calls.map((c: any[]) => c[0]).join("\n");
      expect(out).toContain("/context-mode");
      expect(out).toContain("local Claude");
    });

    it("/help hides context-mode for participant without onThink", () => {
      const ctx = createMockContext({ role: "participant", onThink: undefined });
      handleSlashCommand("/help", ctx);
      const out = (ctx.ui.showSystem as any).mock.calls.map((c: any[]) => c[0]).join("\n");
      expect(out).not.toContain("/context-mode");
    });
  });

  describe("/reply and /r", () => {
    it("/reply calls onReply with the message", () => {
      const onReply = vi.fn();
      const ctx = createMockContext({ onReply });
      expect(handleSlashCommand("/reply hello back", ctx)).toBe(true);
      expect(onReply).toHaveBeenCalledWith("hello back");
    });

    it("/r is an alias for /reply", () => {
      const onReply = vi.fn();
      const ctx = createMockContext({ onReply });
      expect(handleSlashCommand("/r thanks!", ctx)).toBe(true);
      expect(onReply).toHaveBeenCalledWith("thanks!");
    });

    it("/reply with no message shows usage", () => {
      const onReply = vi.fn();
      const ctx = createMockContext({ onReply });
      handleSlashCommand("/reply", ctx);
      expect(onReply).not.toHaveBeenCalled();
      const out = (ctx.ui.showSystem as any).mock.calls.map((c: any[]) => c[0]).join("\n");
      expect(out).toContain("Usage:");
    });

    it("/reply without onReply shows 'no whisper to reply to' message", () => {
      const ctx = createMockContext({ onReply: undefined });
      expect(handleSlashCommand("/reply hey", ctx)).toBe(true);
      const out = (ctx.ui.showSystem as any).mock.calls.map((c: any[]) => c[0]).join("\n");
      expect(out).toContain("No whisper to reply to");
    });

    it("/help shows /reply command for all roles", () => {
      const ctx = createMockContext({ role: "host" });
      handleSlashCommand("/help", ctx);
      const out = (ctx.ui.showSystem as any).mock.calls.map((c: any[]) => c[0]).join("\n");
      expect(out).toContain("/reply");
    });
  });

  describe("/think and /private", () => {
    it("/think calls onThink with the prompt", () => {
      const onThink = vi.fn();
      const ctx = createMockContext({ onThink });
      expect(handleSlashCommand("/think what is this function?", ctx)).toBe(true);
      expect(onThink).toHaveBeenCalledWith("what is this function?");
    });

    it("/private is an alias for /think", () => {
      const onThink = vi.fn();
      const ctx = createMockContext({ onThink });
      expect(handleSlashCommand("/private brainstorm alternatives", ctx)).toBe(true);
      expect(onThink).toHaveBeenCalledWith("brainstorm alternatives");
    });

    it("/think with no prompt shows usage", () => {
      const onThink = vi.fn();
      const ctx = createMockContext({ onThink });
      handleSlashCommand("/think", ctx);
      expect(onThink).not.toHaveBeenCalled();
      const calls = (ctx.ui.showSystem as any).mock.calls.map((c: any[]) => c[0]).join("\n");
      expect(calls).toContain("Usage:");
    });

    it("/think without local claude shows 'not available' message", () => {
      const ctx = createMockContext({ onThink: undefined });
      expect(handleSlashCommand("/think something", ctx)).toBe(true);
      const calls = (ctx.ui.showSystem as any).mock.calls.map((c: any[]) => c[0]).join("\n");
      expect(calls).toContain("--with-claude");
    });

    it("/help shows /think command when participant has onThink", () => {
      const onThink = vi.fn();
      const ctx = createMockContext({ role: "participant", onThink });
      handleSlashCommand("/help", ctx);
      const calls = (ctx.ui.showSystem as any).mock.calls.map((c: any[]) => c[0]).join("\n");
      expect(calls).toContain("/think");
      expect(calls).toContain("/private");
    });

    it("/help hides /think command when onThink is not set", () => {
      const ctx = createMockContext({ role: "participant", onThink: undefined });
      handleSlashCommand("/help", ctx);
      const calls = (ctx.ui.showSystem as any).mock.calls.map((c: any[]) => c[0]).join("\n");
      expect(calls).not.toContain("/think");
    });
  });
});

describe("resolveTypingTargets", () => {
  const participants = ["alice", "bob", "charlie"];

  it("returns null for plain messages (broadcast)", () => {
    expect(resolveTypingTargets("hello world", participants)).toBeNull();
    expect(resolveTypingTargets("", participants)).toBeNull();
    expect(resolveTypingTargets("/help", participants)).toBeNull();
  });

  it("returns null for @claude prompt (broadcast)", () => {
    expect(resolveTypingTargets("@claude fix the bug", participants)).toBeNull();
    expect(resolveTypingTargets("@Claude ", participants)).toBeNull();
  });

  it("returns [] for bare @ (suppress — target unknown)", () => {
    expect(resolveTypingTargets("@", participants)).toEqual([]);
  });

  it("returns [] for partial @name that doesn't match (suppress)", () => {
    expect(resolveTypingTargets("@ali", participants)).toEqual([]);
    expect(resolveTypingTargets("@unknown", participants)).toEqual([]);
  });

  it("returns target once full name is typed", () => {
    expect(resolveTypingTargets("@alice", participants)).toEqual(["alice"]);
    expect(resolveTypingTargets("@alice ", participants)).toEqual(["alice"]);
    expect(resolveTypingTargets("@alice hello there", participants)).toEqual(["alice"]);
  });

  it("resolves multiple targets for multi-whisper", () => {
    expect(resolveTypingTargets("@alice @bob hey", participants)).toEqual(["alice", "bob"]);
  });

  it("stops at first unresolved target (partial name)", () => {
    expect(resolveTypingTargets("@alice @unkn", participants)).toEqual(["alice"]);
  });

  it("is case-insensitive for matching but returns found name", () => {
    expect(resolveTypingTargets("@Alice hey", participants)).toEqual(["alice"]);
  });
});

describe("parseWhisper", () => {
  const participants = ["alice", "bob", "charlie"];

  it("returns null for plain messages", () => {
    expect(parseWhisper("hello world", participants)).toBeNull();
  });

  it("returns null for @claude prefix", () => {
    expect(parseWhisper("@claude fix the bug", participants)).toBeNull();
  });

  it("parses single target whisper", () => {
    const result = parseWhisper("@alice hey there", participants);
    expect(result).toEqual({ targets: ["alice"], text: "hey there" });
  });

  it("parses multiple target whisper", () => {
    const result = parseWhisper("@alice @bob hello friends", participants);
    expect(result).toEqual({ targets: ["alice", "bob"], text: "hello friends" });
  });

  it("returns null for @name with no message text", () => {
    expect(parseWhisper("@alice", participants)).toBeNull();
    expect(parseWhisper("@alice ", participants)).toBeNull();
  });

  it("returns null for unknown @name", () => {
    expect(parseWhisper("@unknown hello", participants)).toBeNull();
  });

  it("stops parsing targets at unknown name", () => {
    const result = parseWhisper("@alice @unknown hello", participants);
    // @alice is a target, @unknown is not known so it becomes part of the text
    expect(result).toEqual({ targets: ["alice"], text: "@unknown hello" });
  });

  it("is case-insensitive for name matching", () => {
    const result = parseWhisper("@Alice hey", participants);
    expect(result).toEqual({ targets: ["Alice"], text: "hey" });
  });
});
