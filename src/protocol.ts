import type { ParticipantIdentity, ParticipantInfo } from "./participant.js";

// ---- Base ----

export interface BaseMessage {
  type: string;
  timestamp: number;
  seq?: number; // Server-assigned monotonic sequence number
}

// ---- Sender identity ----

export interface SenderInfo {
  id: string;
  name: string;
  role: "host" | "participant";
}

// ---- Client → Server ----

export interface PromptMessage extends BaseMessage {
  type: "prompt";
  id: string;
  user: string;
  text: string;
  source?: "host" | "participant";
  sender?: SenderInfo;
}

export interface TypingMessage extends BaseMessage {
  type: "typing";
  user: string;
  isTyping: boolean;
}

export interface ApprovalResponse extends BaseMessage {
  type: "approval_response";
  promptId: string;
  approved: boolean;
}

export interface JoinRequest extends BaseMessage {
  type: "join";
  user: string;
  passwordHash: string;
}

export interface ChatMessage extends BaseMessage {
  type: "chat";
  id: string;
  user: string;
  text: string;
  source?: "host" | "participant";
  sender?: SenderInfo;
  isAgentResponse?: boolean;
}

export interface WhisperMessage extends BaseMessage {
  type: "whisper";
  id: string;
  targets: string[]; // participant names
  text: string;
  sender?: SenderInfo;
}

export interface AgentModeToggle extends BaseMessage {
  type: "agent_mode_toggle";
  enabled: boolean;
  participantId: string;
}

export interface ContextModeChange extends BaseMessage {
  type: "context_mode_change";
  mode: "full" | "prompt-only";
}

// ---- Server → Client(s) ----

export interface JoinAccepted extends BaseMessage {
  type: "join_accepted";
  sessionId: string;
  hostUser: string;
  approvalMode: boolean;
  participantId: string;
  participants: ParticipantInfo[];
}

export interface JoinRejected extends BaseMessage {
  type: "join_rejected";
  reason: string;
}

export interface ParticipantJoined extends BaseMessage {
  type: "participant_joined";
  participant: ParticipantInfo;
}

export interface ParticipantLeft extends BaseMessage {
  type: "participant_left";
  participant: { id: string; name: string };
}

export interface PromptReceived extends BaseMessage {
  type: "prompt_received";
  promptId: string;
  user: string;
  text: string;
  source?: "host" | "participant";
  sender?: SenderInfo;
}

export interface ApprovalRequest extends BaseMessage {
  type: "approval_request";
  promptId: string;
  user: string;
  text: string;
}

export interface StreamChunk extends BaseMessage {
  type: "stream_chunk";
  text: string;
}

export interface ToolUseMessage extends BaseMessage {
  type: "tool_use";
  tool: string;
  input: Record<string, unknown>;
}

export interface ToolResultMessage extends BaseMessage {
  type: "tool_result";
  tool: string;
  output: string;
}

export interface TurnComplete extends BaseMessage {
  type: "turn_complete";
  cost: number;
  durationMs: number;
}

export interface PresenceMessage extends BaseMessage {
  type: "presence";
  users: Array<{ name: string; role: "host" | "participant" }>;
}

export interface NoticeMessage extends BaseMessage {
  type: "notice";
  message: string;
}

export interface ErrorMessage extends BaseMessage {
  type: "error";
  message: string;
}

export interface ChatReceived extends BaseMessage {
  type: "chat_received";
  user: string;
  text: string;
  source?: "host" | "participant";
  sender?: SenderInfo;
  isAgentResponse?: boolean;
}

export interface WhisperReceived extends BaseMessage {
  type: "whisper_received";
  sender: SenderInfo;
  targets: string[];
  text: string;
}

export interface TypingIndicator extends BaseMessage {
  type: "typing_indicator";
  user: string;
  isTyping: boolean;
}

export interface ApprovalStatusMessage extends BaseMessage {
  type: "approval_status";
  promptId: string;
  status: "pending" | "approved" | "rejected";
}

export interface HistoryMessage {
  role: "user" | "assistant" | "tool";
  user?: string;
  text: string;
  toolName?: string;
  cost?: number;
  timestamp: number;
}

export interface HistoryReplayMessage extends BaseMessage {
  type: "history_replay";
  messages: HistoryMessage[];
  sessionId: string;
  resumedFrom: number;
}

// ---- Union Types ----

export type ClientMessage =
  | PromptMessage
  | TypingMessage
  | ApprovalResponse
  | JoinRequest
  | ChatMessage
  | WhisperMessage
  | AgentModeToggle
  | ContextModeChange;

export type ServerMessage =
  | JoinAccepted
  | JoinRejected
  | ParticipantJoined
  | ParticipantLeft
  | PromptReceived
  | ApprovalRequest
  | ApprovalStatusMessage
  | StreamChunk
  | ToolUseMessage
  | ToolResultMessage
  | TurnComplete
  | PresenceMessage
  | NoticeMessage
  | ErrorMessage
  | ChatReceived
  | WhisperReceived
  | HistoryReplayMessage
  | TypingIndicator
  | AgentModeToggle;

export type Message = ClientMessage | ServerMessage;

// ---- Type Guards ----

export function isPromptMessage(msg: unknown): msg is PromptMessage {
  return isObject(msg) && msg.type === "prompt";
}

export function isStreamChunk(msg: unknown): msg is StreamChunk {
  return isObject(msg) && msg.type === "stream_chunk";
}

export function isApprovalRequest(msg: unknown): msg is ApprovalRequest {
  return isObject(msg) && msg.type === "approval_request";
}

export function isApprovalResponse(msg: unknown): msg is ApprovalResponse {
  return isObject(msg) && msg.type === "approval_response";
}

export function isPresenceMessage(msg: unknown): msg is PresenceMessage {
  return isObject(msg) && msg.type === "presence";
}

export function isJoinRequest(msg: unknown): msg is JoinRequest {
  return isObject(msg) && msg.type === "join";
}

export function isChatMessage(msg: unknown): msg is ChatMessage {
  return isObject(msg) && msg.type === "chat";
}

export function isWhisperMessage(msg: unknown): msg is WhisperMessage {
  return isObject(msg) && msg.type === "whisper";
}

export function isTypingMessage(msg: unknown): msg is TypingMessage {
  return isObject(msg) && msg.type === "typing";
}

export function isHistoryReplay(msg: unknown): msg is HistoryReplayMessage {
  return isObject(msg) && msg.type === "history_replay";
}

export function isAgentModeToggle(msg: unknown): msg is AgentModeToggle {
  return isObject(msg) && msg.type === "agent_mode_toggle";
}

export function isContextModeChange(msg: unknown): msg is ContextModeChange {
  return isObject(msg) && msg.type === "context_mode_change";
}

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && "type" in val;
}
