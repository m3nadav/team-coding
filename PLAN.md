# team-claude: Multi-Participant Collaborative Coding Sessions

## Context

**claude-duet** is a 1-host + 1-guest CLI tool for sharing Claude Code sessions. It has solid foundations (encrypted WebSocket/WebRTC transport, headless Claude Code wrapper, approval-gated prompt routing, raw-mode terminal UI) but is architecturally limited to exactly 2 participants.

**team-claude** upgrades this into a multi-participant platform where N users join a session, chat with each other, share a host Claude Code instance, optionally run their own private Claude for brainstorming, and can toggle an agent mode where their local Claude auto-participates in the group chat.

## Architecture Decision: Chat Fan-Out

**Chosen approach: Host-centric fan-out with in-memory participant map** (no Socket.IO, no Redis).

Why this is right for 2-10 participants:
- Fan-out is O(n) where n ≤ 10 — trivially fast, no bottleneck
- The host already runs the shared Claude process and manages session state
- Single sequencer (the host) gives total message ordering for free via a monotonic counter
- No new dependencies — keeps using raw `ws` library already in the codebase
- Matches the existing architecture's trust model (host controls the session)

Alternatives considered and rejected:
- **Socket.IO rooms**: Would require replacing the `ws` library, adds 50KB+ dependency for abstraction we don't need at this scale
- **Redis pub/sub**: Only needed for horizontal scaling across multiple server processes — overkill for a single-host CLI tool
- **Peer-to-peer mesh**: Would break the host-as-authority model needed for Claude prompt approval and message ordering

## Architecture Decision: Host Role & Sender Identity

The existing `source: "host" | "guest"` field is replaced with a richer `sender: { id, name, role }` object. However, **the `role` field preserves host authority**:
- `role: 'host'` — the session owner, has approval power, can kick, can toggle trust mode
- `role: 'participant'` — everyone else, subject to approval gates

The host's special powers are checked via `sender.role === 'host'`, not by the old binary host/guest distinction. This cleanly extends to N participants while preserving all host privileges (approval, kick, trust toggle, agent-mode override).

---

## Configuration: Participant Limit

- Default max participants: **10**
- Host can override via CLI flag: `team-claude host --max-participants 20`
- Server enforces the limit: new connections beyond the cap receive a `join_rejected` with reason `"Session is full (max N participants)"`
- CLI help text for `--max-participants` includes a warning: `"⚠ Performance may degrade with more than 10 participants due to fan-out overhead and Claude context size"`
- Stored in `ServerOptions` and checked in `handleConnection()` via `registry.size() >= maxParticipants`

---

## Phase 0: Fork & Scaffold

**Goal**: Get claude-duet code into this repo, rebrand, and prepare the foundation.

1. Add claude-duet as a git remote and merge its code into this repo
2. Create `README.md` with:
   - team-claude description and features
   - Clear credit: "Forked from [claude-duet](https://github.com/EliranG/claude-duet) by EliranG"
   - Note that claude-duet is MIT licensed and team-claude maintains the same license
   - Include the original MIT LICENSE file
3. Rename package to `team-claude` in `package.json`, update bin entry
4. `npm install` and verify `npm run build` + `npm test` pass
5. Update `src/index.ts` CLI name/description
6. Commit with clear attribution

**Files**: `package.json`, `src/index.ts`, `README.md`, `LICENSE`

---

## Phase 1: Multi-Participant Server

**Goal**: Replace single-guest with N-participant support. This is the core architectural change.

### 1.1 Participant Registry — new `src/participant.ts`

```typescript
interface Participant {
  id: string;           // UUID assigned on join
  name: string;         // Display name
  role: 'host' | 'participant';
  ws: WebSocket | null; // null for the host (local)
  joinedAt: number;
  agentMode: boolean;   // Phase 5
  contextMode: 'full' | 'prompt-only'; // Phase 3 — Claude prompt context preference
}

class ParticipantRegistry {
  // Map<id, Participant>, methods: add, remove, getByName, getById,
  // getAll, getRemote (excludes host), validateNameUnique
}
```

### 1.2 Protocol Extensions — update `src/protocol.ts`

Add to existing types:
- **`participant_joined`** (server→all): `{ id, name, role }`
- **`participant_left`** (server→all): `{ id, name }`
- **`participant_list`** (server→joiner): full list on join
- **`seq`** field on all server→client messages (monotonic counter)
- Update `JoinAccepted` to include `participantId` and `participants[]`
- Replace `source: "host" | "guest"` with `sender: { id, name, role }` throughout
  - **Note**: `role: 'host'` retains all approval/admin powers — the host is identified by role, not by the old binary source field

### 1.3 Server Rewrite — update `src/server.ts`

Key changes to `ClaudeDuetServer`:
- Replace `private guest?: WebSocket` + `private guestUser?: string` with `ParticipantRegistry`
- **Remove** the single-guest guard in `handleConnection()` (line 77-87)
- `broadcast(msg, exclude?)` iterates all remote participants instead of sending to one guest
- `sendTo(participantId, msg)` for targeted messages (whispers, errors)
- `handleMessage()` identifies sender by their WebSocket reference via registry lookup
- Host messages injected via `injectLocalMessage(msg)` (no WebSocket round-trip)
- Each WebSocket connection tracked in registry with its participant ID

### 1.4 Client Updates — update `src/client.ts`

- Handle `participant_joined`, `participant_left`, `participant_list` messages
- Maintain local participant list for display and whisper targeting
- `JoinAccepted` now includes assigned participant ID — store it

### 1.5 Command Updates

- **`src/commands/host.ts`**: Register host as local participant. Update `guest_joined`/`guest_left` events to `participant_joined`/`participant_left`. Remove single-partner assumptions (`cmdCtx.partnerName` → participant list). Add `--max-participants <n>` flag (default 10) with performance warning in help text.
- **`src/commands/join.ts`**: No structural changes needed — client connects the same way.
- **`src/commands/session-commands.ts`**: `/kick` takes a name argument. `/status` shows all participants.

### 1.6 UI Updates — update `src/ui.ts`

- `showPartnerJoined`/`showPartnerLeft` → `showParticipantJoined`/`showParticipantLeft`
- Color-code participant names (assign colors from a palette on join)
- Typing indicator supports multiple concurrent typers

**Testing**: Start host, 3 clients join, verify all receive join notifications. Test name collision rejection. Test disconnect broadcasts leave.

---

## Phase 2: Chat with Ordering & Whispers

**Goal**: Full group chat with total ordering and direct messages.

### 2.1 Chat Manager — new `src/chat.ts`

Lives on the host server, manages message state:

```typescript
class ChatManager {
  private nextSeq = 1;
  private history: Array<{ seq: number; msg: ServerMessage }> = []; // bounded, last 500

  handleChat(msg, sender, registry): void
  // Assigns seq, adds sender identity, broadcasts to all

  handleWhisper(msg, sender, registry): void
  // Parses targets, sends only to named participants + echo to sender
}
```

Server assigns `seq` to every outgoing message. All participants see same ordering.

### 2.2 Whisper Syntax

Client-side parsing in input handler:
- `@alice @bob hello` → whisper to alice and bob with content "hello"
- Leading `@name` tokens are parsed as targets; remaining text is the message
- If no `@name` prefix → regular chat message
- **Exception**: `@claude` prefix still routes to shared Claude (existing behavior)

Protocol addition:
```typescript
interface WhisperMessage extends BaseMessage {
  type: "whisper";
  id: string;
  targets: string[];  // participant names
  text: string;
  sender: { id: string; name: string };
}

interface WhisperReceived extends BaseMessage {
  type: "whisper_received";
  sender: { id: string; name: string };
  targets: string[];
  text: string;
  seq: number;
}
```

### 2.3 UI Formatting

- Chat: `[alice] hello world`
- Whisper received: `[whisper from alice] hey just you`
- Whisper sent: `[whisper to bob, charlie] hey friends`
- System: `--- alice joined ---`

### 2.4 New Slash Commands

| Command | Who | Action |
|---------|-----|--------|
| `/who` | all | List participants with status |
| `/kick <name>` | host | Disconnect a participant (now takes name arg) |
| `/name <new>` | all | Change display name |

**Testing**: 4 participants — one sends chat, other 3 receive with correct seq. Whisper `@bob msg` only reaches bob. Invalid target returns error.

---

## Phase 3: Shared Claude Integration (Multi-Participant)

**Goal**: Adapt the existing Claude prompt/approval/streaming flow for N participants.

### 3.1 Router Updates — update `src/router.ts`

- `source: "host" | "guest"` → use sender identity from participant
- Approval flow: any participant with `role !== 'host'` has their prompts gated when approval mode is on. The host is identified by `sender.role === 'host'`, preserving their bypass privilege.
- **Conversation context**: Router tracks a pointer into chat history. On each prompt to Claude, it collects all chat messages since Claude's last response and prepends them:

```
[Team chat context]
alice: I think the auth module needs refactoring
bob: agreed, token refresh is broken

[Prompt from charlie]
Fix the token refresh logic in src/auth.ts
```

- **Context mode per participant**: Each participant can configure whether their prompts to the shared Claude include the conversation context or just the raw prompt:
  - `full` (default): Prompt includes chat context since last Claude response
  - `prompt-only`: Only the raw prompt text is sent, no chat context
  - Configured via `/context-mode full|prompt-only` slash command
  - Stored on the `Participant` object and sent to server so the router respects it
  - Use case: In noisy chat sessions, participants can avoid sending irrelevant chat as context to save tokens and keep Claude focused

- Prompt queue: Only one Claude interaction at a time (existing `busy` flag in ClaudeBridge). Additional prompts queue with FIFO ordering.

### 3.2 Streaming Broadcast

Claude events (`stream_chunk`, `tool_use`, `tool_result`, `turn_complete`) already broadcast via `server.broadcast()` in `host.ts` (lines 47-74). This now automatically goes to all participants since `broadcast()` was updated in Phase 1.

### 3.3 Approval UX for Multiple Prompters

- `prompt_received` broadcast shows who sent the prompt to all participants
- `approval_request` only shown to host (they approve/reject) — host identified by `role === 'host'`
- `approval_status` broadcast lets the prompter and everyone else see the decision

**Testing**: Prompt → approval → response → broadcast to all. Test prompt queue (second prompt while first is processing). Test `context-mode prompt-only` sends raw prompt without chat context. Test `context-mode full` includes chat history.

---

## Phase 4: Private Local Claude Code

**Goal**: Each participant can optionally run their own local Claude for private brainstorming.

### 4.1 Local Claude — new `src/local-claude.ts`

Reuses `ClaudeBridge` but runs on the participant's machine:

```typescript
class LocalClaude {
  private bridge: ClaudeBridge;
  agentMode: boolean = false;

  constructor(cwd: string) {
    this.bridge = new ClaudeBridge({ cwd, permissionMode: 'auto' });
  }

  async start(): Promise<void>
  sendPrompt(text: string): void  // private, local only
  onResponse(handler): void       // stream chunks to local UI only
}
```

### 4.2 Join Command Update — update `src/commands/join.ts`

Add `--with-claude` flag:
```
team-claude join <code> --name alice --with-claude
```

When set: after successful WebSocket join, spawn a local `ClaudeBridge`. Its output is rendered only in the local terminal — never sent to the server.

### 4.3 Private Command — `/think <prompt>`

- Sends prompt to local Claude only
- Response streams in local UI with distinct formatting: `[your claude] response text`
- Never transmitted to the server
- Alternative alias: `/private <prompt>`

### 4.4 UI Indicators

- Status line: `[local claude: active]` when local Claude is running
- Private responses visually distinct from shared Claude responses (different color/icon)

**Testing**: `/think` prompt stays local (verify no server messages sent). Local Claude cleanup on disconnect.

---

## Phase 5: Agent Mode

**Goal**: A participant's local Claude auto-participates in the group chat.

### 5.1 Toggle Command — `/agent-mode`

Flow:
1. User types `/agent-mode`
2. UI shows warning: `"Agent mode will automatically forward all chat messages to your local Claude and send its responses to the group chat. Your Claude will act on your behalf. Continue? [y/N]"`
3. On `y`: set `localClaude.agentMode = true`, send `agent_mode_toggle` to server
4. Server broadcasts: `--- alice enabled agent mode ---`
5. `/agent-mode off` reverses it

### 5.2 Auto-Forward/Auto-Respond

When `agentMode === true` on a participant's client:
1. Incoming `chat_received` from another participant → forward to local Claude as prompt with context:
   `"You are [name] in a group coding session. [sender] said: [message]. Respond helpfully and concisely."`
2. Local Claude response → auto-send as `chat` message to server
3. Server tags it with `isAgentResponse: true` so UI shows: `[alice's agent] response text`

### 5.3 Safeguards

- **Loop prevention**: Agent does NOT auto-respond to messages with `isAgentResponse: true`
- **Rate limiting**: Max 1 agent response per 5 seconds
- **Host control**: Host can `/kick` misbehaving agent-mode participants
- **Host remote disable**: Host can `/agent-mode off <participant-name>` to disable a participant's agent mode without kicking them. This sends an `agent_mode_toggle { enabled: false }` to that participant's client, which deactivates agent mode locally and broadcasts the status change to all.
- **Manual override**: User can still type manual messages while agent mode is on

### 5.4 Protocol Additions

```typescript
interface AgentModeToggle extends BaseMessage {
  type: "agent_mode_toggle";
  enabled: boolean;
  participantId: string;
}
// ChatMessage/ChatReceived gets: isAgentResponse?: boolean
```

### 5.5 New Slash Commands

| Command | Who | Action |
|---------|-----|--------|
| `/agent-mode` | participant (with local claude) | Toggle own agent mode on (with confirmation) |
| `/agent-mode off` | participant | Toggle own agent mode off |
| `/agent-mode off <name>` | host | Remotely disable a participant's agent mode |

**Testing**: Toggle sends notification. Incoming chat triggers local Claude when on. Agent does NOT respond to other agent responses. Rate limiting works. Host `/agent-mode off alice` disables alice's agent mode without kicking her.

---

## Phase 6: Session Resume / Continue

**Goal**: Let the host and participants resume a previous Claude session so context isn't lost between team sessions.

### UX recommendation: `--continue` as the default; `--resume <id>` as the power-user escape hatch

| Flag | Behaviour | Best for |
|------|-----------|----------|
| `--continue` | Picks up the most recent session in the current working directory | Default flow — "just continue where we left off" |
| `--resume <id>` | Restores a specific session by ID | Power users who maintain multiple named sessions or need to roll back to an earlier checkpoint |

**Recommendation**: Expose `--continue` prominently (mention in the join hint, tab-complete it) and bury `--resume` as a flag that requires knowing the session ID.  The host already has both flags; this phase adds them to the participant's local Claude path and makes the UX discoverable.

### 6.1 Host — already implemented; discovery improvement only

The host already supports `--continue` and `--resume <id>` (passed to ClaudeBridge). What's missing:
- When the host starts with `--continue`, broadcast a notice to participants on join: `"Host resumed a previous Claude session"`
- When the host starts with `--resume <id>`, broadcast: `"Host resumed Claude session ${id.slice(0, 8)}…"`
- This lets participants know they're in a continued session and may ask for a summary

### 6.2 Participant local Claude — new flags on `join`

Add to `team-claude join`:
```
--continue          Resume your most recent local Claude session (--with-claude implied)
--resume <id>       Resume a specific local Claude session by ID (--with-claude implied)
```

- Both flags imply `--with-claude` (no need to pass both)
- Pass flags through to `LocalClaude` → `ClaudeBridge` options
- On successful start, show: `"Resumed your local Claude session"` vs `"Started a fresh local Claude session"`

### 6.3 Config persistence — save last local session ID

When a participant's local Claude emits `session_init` (which includes the session ID), save it to the team-claude config (`~/.team-claude.json` under key `lastLocalSessionId`). On the next `--continue` invocation, this ID is used automatically. This mirrors how the Claude CLI's own `--continue` works.

### 6.4 `/session` command — show local session info

Add `/session` slash command (participants only):
- Shows current local Claude session ID (truncated to 8 chars + `…`)
- Shows whether it was resumed or fresh
- Shows a hint: `"Use --continue next time to resume this session"`
- Example output:
  ```
  Local Claude session: a3f9bc12… (fresh)
  Tip: join with --continue to resume this next time
  ```

### 6.5 Protocol update

When the host starts with `--continue` or `--resume`, include `resumedSession: boolean` and optionally `sessionId?: string` in the `JoinAccepted` message so the UI can inform joining participants.

### 6.6 File changes

| File | Change |
|------|--------|
| `src/index.ts` | Add `--continue` / `--resume <id>` to `join` command; both imply `--with-claude` |
| `src/local-claude.ts` | Accept `continue` and `resume` options, pass to ClaudeBridge |
| `src/commands/join.ts` | Wire new flags; save `lastLocalSessionId` on `session_init`; update hint text |
| `src/commands/host.ts` | Broadcast resume notice to joining participants |
| `src/commands/session-commands.ts` | Add `/session` command (participant only) |
| `src/config.ts` | Add `lastLocalSessionId` to config schema |
| `src/protocol.ts` | Add `resumedSession` / `sessionId` to `JoinAccepted` |

**Testing**: Join with `--continue` → local Claude session restores. Join without flag → fresh session. `/session` shows correct ID and resume status. Host `--continue` triggers broadcast notice to all participants on join. `--resume <id>` with a bad ID shows a clear error.

---

## Phase 7: `/reply` Command

**Goal**: Let any participant instantly reply to the last person who whispered them, without re-typing the target name.

### 7.1 Behaviour

- `/reply <message>` — sends a whisper back to the most recent participant who sent *you* a whisper
- "Last whisperer" is tracked per-client in memory; it updates every time a `whisper_received` event arrives
- If no whisper has been received yet in this session, show: `"No whisper to reply to yet — use @name <message> to start one"`
- Works symmetrically: after alice whispers bob, bob can `/reply hi` and it goes back to alice; if charlie then whispers bob, `/reply` goes to charlie instead

### 7.2 State tracking

Client-side only — no protocol changes needed. In `join.ts` (and `host.ts`), track:

```typescript
let lastWhisperer: string | undefined;

// Update on whisper_received:
case "whisper_received":
  lastWhisperer = w.sender?.name;
  // ...existing display logic
```

The host also receives whispers (via the server's whisper routing), so the same tracking applies in `host.ts`.

### 7.3 `/reply` as a slash command

Add to `CommandContext`:
```typescript
onReply?: (message: string) => void;
```

In `session-commands.ts`:
```
/reply <message>  — Reply to the last participant who whispered you
```

The command handler calls `ctx.onReply?.(message)`. Each caller (`join.ts`, `host.ts`) wires `onReply` to:
1. Check `lastWhisperer` is set — show error if not
2. Call the same whisper-send path as `@name message`

### 7.4 Autocomplete

Add ghost suggestion:
- `/r` → `/reply ` (only for participants/host — always available once connected)
- `/re` → `/reply `, `/rep` → `/reply `, `/repl` → `/reply `, `/reply` → `/reply `

No conflict with existing completions at `/r`.

### 7.5 Help entry

```
/reply <message>  — Reply to the last participant who whispered you
```

Shown for all roles (host and participant) in `/help`.

### 7.6 File changes

| File | Change |
|------|--------|
| `src/commands/session-commands.ts` | Add `onReply` to `CommandContext`; handle `/reply` command; add to `/help` |
| `src/commands/join.ts` | Track `lastWhisperer`; wire `onReply` in `cmdCtx` |
| `src/commands/host.ts` | Track `lastWhisperer`; wire `onReply` in `cmdCtx` |
| `src/ui.ts` | Add `/r` → `/reply ` autocomplete suggestions |

**Testing**: alice whispers bob → bob `/reply hi` → alice receives whisper from bob. `/reply` with no prior whisper → clear error. Two whispers from different senders → `/reply` targets the most recent.

---

## File Change Summary

| File | Phase | Change |
|------|-------|--------|
| `package.json` | 0 | Rename, update metadata |
| `README.md` | 0 | **NEW** — description + claude-duet credit + license note |
| `LICENSE` | 0 | Preserve MIT license from claude-duet |
| `src/index.ts` | 0 | Rebrand CLI |
| `src/participant.ts` | 1 | **NEW** — participant model + registry |
| `src/protocol.ts` | 1,2,5 | Add multi-participant message types, seq field, whisper, agent mode |
| `src/server.ts` | 1 | Rewrite for N participants, fan-out, sendTo |
| `src/client.ts` | 1,2 | Handle participant events, whisper parsing |
| `src/chat.ts` | 2 | **NEW** — chat state, ordering, whisper routing |
| `src/commands/host.ts` | 1,3 | Multi-participant events, context building |
| `src/commands/join.ts` | 1,4 | `--with-claude` flag |
| `src/commands/session-commands.ts` | 2,3,4,5 | `/who`, `/kick <name>`, `/think`, `/agent-mode`, `/context-mode` |
| `src/ui.ts` | 1,2,4,5 | Multi-participant display, whispers, agent indicators |
| `src/router.ts` | 3 | Multi-participant approval, conversation context, context-mode support |
| `src/local-claude.ts` | 4 | **NEW** — local Claude wrapper with agent mode |

## Verification Plan

1. **Phase 0**: `npm run build` passes, `npm test` passes, CLI shows `team-claude` branding, README credits claude-duet
2. **Phase 1**: Start host, join with 3 clients in separate terminals. All see join notifications. Send chat messages — all receive them. `/kick alice` disconnects alice, others see leave notification.
3. **Phase 2**: 4 participants chatting. Messages arrive in same order (check seq numbers). `@bob secret` only reaches bob. `/who` shows full list.
4. **Phase 3**: Participant sends `@claude fix the bug`. Host approves. All see streaming response. Second prompt while first is running gets queued. Test `/context-mode prompt-only` vs `full`.
5. **Phase 4**: Join with `--with-claude`. `/think what does this function do?` — response appears only locally. Other participants see nothing.
6. **Phase 5**: `/agent-mode` → confirm → another participant sends a message → local Claude auto-responds → response appears in group chat tagged as agent. Send two messages rapidly → rate limiter triggers. Agent doesn't respond to other agents' messages. Host `/agent-mode off alice` works.
7. **Phase 6**: Join with `--continue` → local Claude resumes prior session. Host with `--continue` → joining participants see a notice. `/session` shows session ID. Joining without any flag → fresh session, hint suggests `--continue` next time.
8. **Phase 7**: Alice whispers bob. Bob types `/reply hi` → alice receives whisper. `/reply` before any whisper → clear error message. Charlie whispers bob → now `/reply` targets charlie instead of alice.
