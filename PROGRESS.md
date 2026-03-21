# team-claude Progress

## Status: Post-Phase 7 Polish

### 2026-03-21 — /reply magic expansion + typing suppression for slash commands

- `src/ui.ts` — Added `onReplyExpansion(fn)` callback; in raw input handler, when space is pressed and buffer is exactly `/reply ` or `/r `, calls the callback and replaces the buffer with `@name ` (the last whisperer), cursor at end — so the user continues typing the message naturally
- `src/commands/join.ts` / `src/commands/host.ts`:
  - Wired `ui.onReplyExpansion(() => lastWhisperer ?? null)` after `startInputLoop()`
  - Added early-return in `onKeystroke` when input starts with `/` — calls `stopTyping()` so slash commands never broadcast a typing indicator to other participants
- 254 tests pass (unchanged)

## Status: Phase 7 Complete (/reply command)

### 2026-03-21 — Phase 7: /reply Command

- **Summary**:
  - `src/commands/join.ts` — Declared `lastWhisperer: string | undefined`; set it in `whisper_received` handler; wired `onReply` in `cmdCtx`: shows outgoing whisper and calls `client.sendWhisper([lastWhisperer], message)`
  - `src/commands/host.ts` — Same: declared `lastWhisperer`, set in `whisper_received` case of `server_message` listener, wired `onReply` in `cmdCtx` using `server.injectLocalMessage`
  - `src/__tests__/session-commands.test.ts` — Added 5 tests for `/reply`/`/r`: calls `onReply`, `/r` alias, no-message shows usage, no `onReply` shows "no whisper" message, `/help` shows `/reply`
  - 254 tests pass (5 new)
- **Next**: All planned phases complete

## Status: Phase 5 Complete + Polish

### 2026-03-21 — README rewrite

- Rewrote `README.md` to reflect all implemented phases; attribution reduced to a single line at the bottom before the license

### 2026-03-21 — System message formatting

- `src/ui.ts`: `showSystem()` now prefixes every message with `[system]` (no indentation) so system messages are visually distinct from chat
- `src/commands/host.ts`: Added `notice` handler in `server_message` listener — host now sees broadcast notices (agent mode toggles, context mode changes, etc.) that were previously silently dropped

### 2026-03-21 — Agent mode context + whisper reply

- `src/commands/join.ts`:
  - Shared Claude responses accumulate via `stream_chunk` and are added to `localChatHistory` as `"Claude: ..."` on `turn_complete`, so the agent's local Claude sees host Claude responses in context
  - `localContextStartIndex` tracks the context window start; resets after each Claude response (shared or local), matching the router's sliding-window behaviour
  - Agent auto-responds to incoming whispers with a whisper back to the sender (`agentTurnWhisperTarget`); group-chat messages still get `sendChat(…, true)`
  - All disable paths (manual, remote, error) clear `agentTurnWhisperTarget`
- 249 tests pass (unchanged)

### 2026-03-21 — Phase 5: Agent Mode

- **Summary**:
  - `src/client.ts` — Added `sendAgentModeToggle(enabled, participantId)`
  - `src/commands/session-commands.ts` — Added `onAgentModeToggle` and `isAgentMode` to `CommandContext`; `/agent-mode` now fully handled (was returning `false`); added to `/help` for `--with-claude` participants
  - `src/ui.ts` — Added `showConfirmation(message, onResult)`; extended `showUserPrompt` mode to `"chat"|"claude"|"agent"`; added `/agent-mode` autocomplete gated on `localClaudeActive`
  - `src/commands/join.ts` — Agent mode state machine: `agentModeEnabled`, `isAgentTurn`, `agentResponseBuffer`, `lastAgentResponseTime`; local Claude event handler buffers and broadcasts agent responses; `onAgentModeToggle` wired in `cmdCtx`; handles `agent_mode_toggle` from server for remote disable; rate limit (5 s) and loop prevention (`isAgentResponse`)
  - 249 tests pass (6 new for `/agent-mode`)

## Status: Post-Phase 4 Polish

### 2026-03-21 — Whisper display style

- **Summary**:
  - Updated `src/ui.ts` — Added `showWhisper(direction, user, targets, text, senderRole)`: incoming whispers render as `alice[whisper]:` in bold yellow/cyan (matching regular chat colors); outgoing as `you[whisper → alice]:` in dim (matching self-message style)
  - Updated `src/commands/join.ts` — Replaced `ui.showSystem("[whisper from/→ ...]")` calls with `ui.showWhisper()`
  - Updated `src/commands/host.ts` — Same replacement for outgoing; added `whisper_received` handling in `server_message` listener so the host now sees incoming whispers directed at them
  - 243 tests pass (unchanged)

### 2026-03-21 — Targeted typing indicators for whispers

- **Summary**:
  - Updated `src/protocol.ts` — Added `targets?: string[]` to `TypingMessage`
  - Updated `src/server.ts` — `routeMessage` for typing: sends `typing_indicator` only to named targets when `targets` is set; suppresses when `targets === []`; added `sendToByName(name, msg)` helper
  - Updated `src/client.ts` — `sendTyping(isTyping, targets?)` accepts optional targets
  - Updated `src/ui.ts` — Added `getCurrentInput()` returning current line buffer; backspace now fires `keystrokeHandler` so target resolution re-evaluates when `@name` is deleted
  - Updated `src/commands/session-commands.ts` — Exported `resolveTypingTargets(input, participantNames)`: returns `null` (broadcast), `[]` (suppress — `@` prefix but target unresolved), or `string[]` (targeted whisper)
  - Updated `src/commands/join.ts` and `src/commands/host.ts` — Replaced `isTyping` bool with `currentTyping: { targets } | null`; stop+restart when targets change mid-compose
  - 243 tests pass (8 new for `resolveTypingTargets`)

## Status: Phase 4 Complete

### 2026-03-21 — Phase 4: Private Local Claude Code

- **Phase**: Phase 4 (complete)
- **Summary**:
  - Created `src/local-claude.ts` — `LocalClaude` class wrapping `ClaudeBridge` with simplified API: `start()`, `sendPrompt(text)` (sends as "you" — no broadcast, purely local), `isBusy()`, `isStarted()`, `stop()`; re-emits all bridge events to its own `EventEmitter` listeners
  - Updated `src/index.ts` — Added `--with-claude` flag to `join` command
  - Updated `src/commands/join.ts` — Accepts `withClaude` option; spawns `LocalClaude` after connecting, wires its events to `ui.showLocalClaudeChunk`/`showLocalClaudeTurnComplete`/`showLocalClaudeError`; shows status on start; updates hint text; adds `onThink` to `cmdCtx` (checks `localClaude` at call time for safe async start failure handling); cleans up on `/leave`, disconnect, and SIGINT
  - Updated `src/commands/session-commands.ts` — Added `onThink?: (prompt: string) => void` to `CommandContext`; handles `/think <prompt>` and `/private <prompt>` commands (alias); shows "not available" message when `onThink` is not set (i.e., `--with-claude` not passed); `/help` dynamically shows `/think`/`/private` only when local Claude is available
  - Updated `src/ui.ts` — Added `showLocalClaudeChunk()` (streams with magenta `◆ your claude` header), `showLocalClaudeTurnComplete()`, `showLocalClaudeError()`, `showLocalClaudeStatus()` (shows `[local claude: active/stopped]`)
  - Created `src/__tests__/local-claude.test.ts` — 10 tests: ClaudeBridge construction, idempotent start, sendPrompt attribution, isBusy delegation, isStarted state, stop cleanup, event re-emission
  - Updated `src/__tests__/session-commands.test.ts` — Added 6 `/think`/`/private` tests: calls onThink, /private alias, no-prompt usage, missing local claude message, /help shows /think when active, /help hides when inactive
  - 224 total tests pass (17 new)
- **Next**: Phase 5 — Agent Mode (`/agent-mode`, auto-forward incoming chat to local Claude, rate limiting, loop prevention)

## Status: Phase 3 Complete

### 2026-03-21 — Phase 3: Shared Claude Integration

- **Phase**: Phase 3 (complete)
- **Summary**:
  - Updated `src/protocol.ts` — Added `contextMode?: "full" | "prompt-only"` field to `PromptMessage`
  - Rewrote `src/router.ts` — Added `ChatEntry`/`QueuedPrompt` interfaces; `addChatMessage()` for history tracking (bounded to 500); `buildContextPrefix()` that collects chat since last Claude response; `executeOrQueue()` that checks `claude.isBusy()` before sending — queues with notice if busy; `processQueue()` drained on every `turn_complete` event; `sendToClaudeWithContext()` prepends `[Team chat context]` block for `contextMode: "full"` or sends raw for `"prompt-only"`
  - Updated `src/server.ts` — In `routeMessage()`, sets `msg.contextMode = sender.contextMode` before emitting `"prompt"` so the router gets the participant's configured mode
  - Updated `src/commands/session-commands.ts` — Added `onContextModeChange` to `CommandContext`; added `/context-mode full|prompt-only` command with validation and help entry
  - Updated `src/client.ts` — Added `sendContextModeChange(mode)` method
  - Updated `src/commands/join.ts` — Wired `onContextModeChange` to `client.sendContextModeChange(mode)`
  - Updated `src/commands/host.ts` — Wired participant and host chat messages to `router.addChatMessage()`; added `onContextModeChange` that calls `server.injectLocalMessage` with `context_mode_change`
  - Updated `src/__tests__/router.test.ts` — Added 8 new tests: queuing when busy (notice broadcast), queue drain on `turn_complete`, FIFO queue order, `full` mode context inclusion, `prompt-only` mode raw pass-through, no context when no chat, old-chat exclusion after response
  - 207 total tests pass (8 new router tests, existing 199 all pass)
- **Next**: Phase 4 — Private Local Claude Code (`--with-claude` flag, `/think` command, local Claude per participant)

## Status: Phase 2 Complete (bug fixes applied)

### 2026-03-21 — Bug Fixes: --name heuristic and approval mode identity

- **Phase**: Post-Phase 2 bug fixes
- **Summary**:
  - `src/index.ts` (join command) — Removed `process.env.USER || "guest"` default from `--name` option so `options.name` is `undefined` when not passed. Name resolution is now `options.name ?? config.name ?? process.env.USER ?? "guest"`, fixing a bug where an explicitly passed name matching the system username was incorrectly treated as "not provided" and overridden by `config.name`.
  - `src/router.ts` — Changed `isHost` check from `msg.source === "host"` to `(msg.sender?.role ?? msg.source) === "host"`. `sender.role` is the server-validated identity set in `routeMessage()` for all participant messages; falls back to `source` for host-originated prompts (injected locally, no `sender`). Prevents any possibility of clients spoofing host identity via a crafted `source` field.
- **Next**: Phase 3 — Shared Claude Integration (multi-participant approval, conversation context, context-mode per participant)

### 2026-03-21 — Phase 2: Chat with Ordering & Whispers

- **Phase**: Phase 2 (complete)
- **Summary**:
  - Updated `src/commands/session-commands.ts` — Added `/who` command, `/kick <name>` with name arg, `/agent-mode off <name>` for host, `parseWhisper()` function (client-side `@name message` parsing, multi-target support, `@claude` exclusion), updated `CommandContext` (added `participantNames: () => string[]`, `onKick(name)`, `onAgentModeOff(name)`)
  - Updated `src/commands/host.ts` — Switched to `participantNames`, `onKick(name)`, `onAgentModeOff`, `participant_joined`/`participant_left` events with proper names
  - Updated `src/commands/join.ts` — Fixed `role: "participant"`, `participantNames`, `source === "participant"` echo suppression
  - Updated `src/client.ts` — Added `sendWhisper(targets, text)`, `sendChat(text, isAgentResponse?)`
  - Updated `src/ui.ts` — Role type supports `"host" | "guest" | "participant"`
  - Updated `src/__tests__/multi-participant.test.ts` — Added 1 new test: "routes whispers only to targeted participants"; fixed timing race in whisper test (register listeners before triggering join)
  - Updated `src/__tests__/session-commands.test.ts` — Added tests for `/who`, `/kick <name>`, `/agent-mode off`, `parseWhisper` (24 total session-command tests)
  - 200 total tests pass (11 multi-participant, 24 session-command)
- **Next**: Phase 3 — Shared Claude Integration (multi-participant approval, conversation context, context-mode per participant)

### 2026-03-21 — Phase 1: Multi-Participant Server

- **Phase**: Phase 1 (complete)
- **Summary**:
  - Created `src/participant.ts` — `ParticipantRegistry` class with add/remove, name uniqueness (case-insensitive), lookup by id/name/ws, host/remote filtering, `toInfoList()`/`toIdentity()`, event emission
  - Rewrote `src/protocol.ts` — Added `SenderInfo`, `ParticipantJoined`, `ParticipantLeft`, `WhisperMessage`, `WhisperReceived`, `AgentModeToggle`, `ContextModeChange`, `seq` field on all server messages, `participantId` + `participants[]` on `JoinAccepted`, replaced `"host"|"guest"` with `"host"|"participant"`, added type guards
  - Rewrote `src/server.ts` — Replaced single-guest model with `ParticipantRegistry`, multi-WebSocket fan-out with `broadcast()` and `sendTo()`, `injectLocalMessage()` for host, `maxParticipants` enforcement, `kickParticipant(name)`, `disableAgentMode(name)`, whisper routing, agent/context mode handling, transport participant support, monotonic `seq` counter
  - Updated all existing tests for "participant" source instead of "guest", new event names
  - Created `src/__tests__/participant.test.ts` (16 tests) and `src/__tests__/multi-participant.test.ts` (10 tests)
  - 188 total tests pass (26 new)
- **Next**: Phase 2 — Chat with ordering & whispers

### 2026-03-21 — Phase 0: Fork & Scaffold

- **Phase**: Phase 0 (complete)
- **Summary**:
  - Merged claude-duet codebase (from `https://github.com/EliranG/claude-duet`) into this repo via git remote + merge with unrelated histories
  - Rebranded all source files: `claude-duet` → `team-claude`, `ClaudeDuet*` → `TeamClaude*`
  - Updated `package.json`: name, version (0.1.0), description, bin entry, repo URLs, keywords
  - Updated `src/index.ts`: CLI name, description, version, added `--max-participants` flag
  - Updated `src/config.ts`: config paths use `team-claude` naming
  - Created `README.md` with clear attribution to claude-duet (EliranG), MIT license note, feature overview
  - Created `CLAUDE.md` with workflow rules (planning, testing, progress tracking, commits)
  - All 162 tests pass, build succeeds
- **Next**: Phase 1 — Multi-participant server (ParticipantRegistry, protocol extensions, server rewrite)

### 2026-03-21 — Initial Plan Created

- **Phase**: Pre-implementation (Planning)
- **Summary**: Explored claude-duet codebase, researched chat architecture patterns, designed 6-phase implementation plan (Phase 0-5).
- **Artifacts**: Plan file at `/Users/nadav/.claude/plans/steady-floating-moler.md`
