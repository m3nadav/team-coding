# team-claude Development Guide

## Project Overview

Multi-participant collaborative coding session platform, forked from [claude-duet](https://github.com/EliranG/claude-duet). Enables N users to share a Claude Code session with group chat, whispers, private local Claude instances, and agent mode.

## Workflow Rules

### Planning

- Every plan lives in `/Users/nadav/.claude/plans/` and is version-controlled.
- After generating or updating a plan, commit it immediately.
- Plans are the source of truth for what to build. Reference `PLAN.md` (symlinked or copied to repo root) for the current implementation plan.

### Implementation

- Follow the phased approach in the plan. Complete phases in order.
- After completing each phase:
  1. Run tests (`npm test`) — all must pass.
  2. Update `PROGRESS.md` with what was completed.
  3. Commit implementation + updated docs together.
  4. **STOP. Do not proceed to the next phase.** Report what was completed and wait for explicit confirmation from the user before continuing.

### Testing

- A task is **not finished** until tests are written, executed, and pass successfully.
- Tests must contain actual assertions and logic. Stub tests that only "pass" without testing real behavior do not count.
- Run tests with `npm test` (vitest).

### Progress Tracking

- `PROGRESS.md` serves as both a changelog and a checkpoint for other sessions/subagents.
- Each entry should include: date, phase/task completed, summary of changes, and any blockers or notes.
- Subagents and parallel sessions must read `PROGRESS.md` before starting work to avoid conflicts.

### Commits

- Commit after each task/step/phase completion.
- Each commit should include implementation + updated docs.
- Use descriptive commit messages referencing the phase/task.

## Build & Test

```bash
npm install        # Install dependencies
npm run build      # Compile TypeScript
npm test           # Run tests (vitest)
npm run dev        # Watch mode
```

## Architecture

- **Host-centric topology**: All messages flow through the host server.
- **Fan-out**: Host maintains `ParticipantRegistry` and broadcasts to all connected WebSockets.
- **Message ordering**: Server-assigned monotonic sequence numbers.
- **Encryption**: NaCl secretbox (XSalsa20 + Poly1305) with scrypt-derived symmetric key.
- **Claude integration**: Headless Claude Code spawned as child process, NDJSON stdin/stdout.

## Key Files (post-implementation)

- `src/server.ts` — Multi-participant WebSocket server with fan-out
- `src/participant.ts` — Participant model and registry
- `src/protocol.ts` — All message type definitions
- `src/chat.ts` — Chat state, ordering, whisper routing
- `src/router.ts` — Prompt routing with approval gates and context building
- `src/claude.ts` — ClaudeBridge headless wrapper
- `src/local-claude.ts` — Per-participant private Claude wrapper
- `src/ui.ts` — Terminal UI
- `src/commands/` — CLI command handlers
