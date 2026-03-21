# team-claude Progress

## Status: Phase 2 Complete

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
