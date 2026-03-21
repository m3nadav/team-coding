# team-claude

Multi-participant collaborative coding sessions — share a Claude Code session with your entire team.

> Forked from [claude-duet](https://github.com/EliranG/claude-duet) by [EliranG](https://github.com/EliranG). Original project is MIT licensed.

## What Is This

A shared terminal session where multiple participants can **chat with each other**, **whisper privately**, **invoke a shared Claude together**, and optionally **run their own private Claude for brainstorming** — all in real-time with end-to-end encryption.

```
you:                hey, do you see the bug in auth.ts?     ← group chat
@claude:            fix the token refresh in src/auth.ts    ← sent to shared Claude
@bob:               check line 42, I think that's it        ← whisper (only bob sees)
/think:             what does this function actually do?     ← private Claude (only you see)
/agent-mode:        let your Claude auto-respond in chat    ← agent mode
```

### Features

- **Multi-participant sessions** — Up to 10 participants (configurable via `--max-participants`)
- **Group chat with ordering** — Server-assigned sequence numbers ensure consistent message order
- **Whispers** — Direct messages via `@name message` syntax
- **Shared Claude Code** — Host runs a headless Claude instance, all participants can prompt it (with approval)
- **Private local Claude** — Join with `--with-claude` to run your own Claude for private brainstorming
- **Agent mode** — `/agent-mode` lets your local Claude auto-participate in group chat
- **Context control** — `/context-mode full|prompt-only` to manage Claude token usage in noisy chats
- **E2E encryption** — NaCl secretbox (XSalsa20 + Poly1305) with scrypt key derivation
- **Multiple connection modes** — WebSocket, WebRTC P2P, tunnels, relay servers

## Quick Start

> Requires [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed on the host machine.

```bash
# Host a session
npx team-claude host --name alice

# Join a session
npx team-claude join <session-code> --password <password> --name bob

# Join with your own private Claude
npx team-claude join <session-code> --password <password> --name charlie --with-claude
```

## CLI Commands

```bash
team-claude host                           # Start a session
team-claude host --max-participants 20     # Allow more participants (default: 10)
team-claude host --continue                # Resume most recent Claude Code session
team-claude host --no-approval             # Trust mode — skip prompt review
team-claude host --tunnel cloudflare       # Remote access via Cloudflare tunnel
team-claude join <code> --password <pw>    # Join a session
team-claude relay                          # Run a self-hosted relay server
team-claude config                         # View/manage configuration
```

## In-Session Commands

| What you type | What happens |
|---------------|--------------|
| `hello!` | Group chat — all participants see it |
| `@claude fix the bug` | Sent to shared Claude — all see the response |
| `@bob check line 42` | Whisper — only bob sees this |
| `/think what does this do?` | Private prompt to your local Claude |
| `/agent-mode` | Toggle: let your Claude auto-respond in chat |
| `/agent-mode off <name>` | (host) Disable a participant's agent mode |
| `/context-mode full\|prompt-only` | Control what context Claude receives |
| `/who` | List all participants |
| `/kick <name>` | (host) Disconnect a participant |
| `/trust` | (host) Skip prompt approval |
| `/approval` | (host) Re-enable prompt approval |
| `/help` | Show available commands |

## How It Works

```
┌──────────────┐
│  Host        │◄──── WebSocket ────► Participant 1 (+ optional local Claude)
│  Claude Code │◄──── WebSocket ────► Participant 2 (+ optional local Claude)
│  (headless)  │◄──── WebSocket ────► Participant N (+ optional local Claude)
│  Chat Server │
└──────────────┘
```

- **Host** runs Claude Code headless + manages the chat server
- **Participants** connect via WebSocket (or WebRTC P2P)
- **Chat** flows through the host with server-assigned sequence numbers for total ordering
- **Shared Claude** prompts go through an approval gate (host reviews)
- **Private Claude** runs locally on each participant's machine — never touches the server

## Security

- **E2E Encrypted** — NaCl secretbox + scrypt key derivation
- **Approval Mode** — host reviews participants' Claude prompts (on by default)
- **Host Controls Everything** — Claude runs on the host's machine, host's API key
- **Agent mode safeguards** — Loop prevention, rate limiting, host override

## Connection Modes

| Mode | Command | When |
|------|---------|------|
| **P2P (default)** | `team-claude host` | Direct WebRTC connection |
| **LAN** | `team-claude host --tunnel localtunnel` | Same Wi-Fi / VPN |
| **Cloudflare** | `team-claude host --tunnel cloudflare` | Remote, no server needed |
| **SSH Tunnel** | `ssh -L 3000:localhost:3000 host` | Remote, secure |
| **Relay** | `team-claude host --relay <url>` | Self-hosted relay |

## Development

```bash
git clone https://github.com/m3nadav/team-claude.git
cd team-claude
npm install
npm run build
npm test
```

Requires Node.js 18+.

## Attribution

This project is forked from [claude-duet](https://github.com/EliranG/claude-duet) by [EliranG](https://github.com/EliranG), which provides the foundational architecture for encrypted session sharing, headless Claude Code integration, and terminal UI. We are grateful for the solid baseline that made team-claude possible.

## License

[MIT](LICENSE) — same license as the original claude-duet project.

Copyright (c) 2026 Eliran G. (original claude-duet)
