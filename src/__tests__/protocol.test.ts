import { describe, it, expect } from "vitest";
import {
  isPromptMessage,
  isStreamChunk,
  isApprovalRequest,
  isPresenceMessage,
  isHistoryReplay,
  isTypingMessage,
  isAgenticDiscussionStart,
  isAgentChainStop,
  type PromptMessage,
  type StreamChunk,
} from "../protocol.js";

describe("protocol type guards", () => {
  it("identifies a prompt message", () => {
    const msg: PromptMessage = {
      type: "prompt",
      id: "abc",
      user: "benji",
      text: "fix the bug",
      timestamp: Date.now(),
    };
    expect(isPromptMessage(msg)).toBe(true);
    expect(isStreamChunk(msg)).toBe(false);
  });

  it("identifies a stream chunk", () => {
    const msg: StreamChunk = {
      type: "stream_chunk",
      text: "Here is the fix...",
      timestamp: Date.now(),
    };
    expect(isStreamChunk(msg)).toBe(true);
    expect(isPromptMessage(msg)).toBe(false);
  });

  it("identifies an approval request", () => {
    const msg = {
      type: "approval_request",
      promptId: "abc",
      user: "benji",
      text: "delete all files",
      timestamp: Date.now(),
    };
    expect(isApprovalRequest(msg)).toBe(true);
  });

  it("identifies a presence message", () => {
    const msg = {
      type: "presence",
      users: [{ name: "eliran", role: "host" }],
      timestamp: Date.now(),
    };
    expect(isPresenceMessage(msg)).toBe(true);
  });

  it("identifies a history replay message", () => {
    const msg = {
      type: "history_replay",
      messages: [{ role: "user", text: "fix bug", timestamp: Date.now() }],
      sessionId: "abc-123",
      resumedFrom: 5,
      timestamp: Date.now(),
    };
    expect(isHistoryReplay(msg)).toBe(true);
    expect(isPromptMessage(msg)).toBe(false);
  });

  it("isTypingMessage identifies typing messages", () => {
    const msg = {
      type: "typing",
      user: "benji",
      isTyping: true,
      timestamp: 1,
    };
    expect(isTypingMessage(msg)).toBe(true);
  });

  it("isTypingMessage rejects non-typing messages", () => {
    const msg = {
      type: "chat",
      id: "abc",
      user: "benji",
      text: "hello",
      timestamp: Date.now(),
    };
    expect(isTypingMessage(msg)).toBe(false);
  });

  it("isAgenticDiscussionStart identifies agentic_discussion_start messages", () => {
    const msg = { type: "agentic_discussion_start", topic: "should we refactor?", timestamp: Date.now() };
    expect(isAgenticDiscussionStart(msg)).toBe(true);
    expect(isPromptMessage(msg)).toBe(false);
  });

  it("isAgenticDiscussionStart rejects other types", () => {
    expect(isAgenticDiscussionStart({ type: "chat", id: "x", user: "a", text: "t", timestamp: 0 })).toBe(false);
    expect(isAgenticDiscussionStart(null)).toBe(false);
  });

  it("isAgentChainStop identifies agent_chain_stop messages", () => {
    const msg = { type: "agent_chain_stop", reason: "hop_limit", seq: 5, timestamp: Date.now() };
    expect(isAgentChainStop(msg)).toBe(true);
    expect(isPromptMessage(msg)).toBe(false);
  });

  it("isAgentChainStop rejects other types", () => {
    expect(isAgentChainStop({ type: "notice", message: "hi", timestamp: 0 })).toBe(false);
    expect(isAgentChainStop(undefined)).toBe(false);
  });

  it("ChatMessage carries agentHops field", () => {
    const msg = {
      type: "chat",
      id: "x",
      user: "alice",
      text: "hello",
      isAgentResponse: true,
      agentHops: 2,
      timestamp: Date.now(),
    };
    expect((msg as any).agentHops).toBe(2);
  });
});
