# team-claude

Multi-participant collaborative coding sessions powered by Claude Code.

## What Is This

A shared terminal where multiple people can **chat**, **whisper privately**, **prompt a shared Claude together**, and optionally **run their own private Claude for brainstorming** — all in real-time with end-to-end encryption.

```
hello!              → group chat, everyone sees it
@claude fix auth.ts → sent to shared Claude, everyone sees the response
@bob check line 42  → whisper, only bob sees it
/think what does…   → private prompt to your own local Claude
/agent-mode         → your local Claude auto-responds to chat on your behalf
```

## Features

- **Multi-participant** — Up to 10 participants (configurable), each identified by name
- **Group chat with ordering** — Server-assigned sequence numbers for consistent message order across all clients
- **Whispers** — Direct messages via `@name message`; typing indicators are targeted to the recipient only
- **Shared Claude Code** — Host runs a headless Claude instance; participants prompt it with optional approval gate
- **Private local Claude** — Join with `--with-claude` for a private Claude that never touches the server
- **Agent mode** — `/agent-mode` lets your local Claude auto-respond to chat and whispers on your behalf, with loop prevention and rate limiting
- **Context control** — `/context-mode full|prompt-only` manages what chat history Claude receives; agent mode inherits this setting and includes shared Claude responses in context
- **Session resume** — Host can `--continue` or `--resume <id>` to pick up a previous Claude Code session
- **E2E encryption** — NaCl secretbox (XSalsa20 + Poly1305) with scrypt key derivation
- **Multiple connection modes** — WebSocket (LAN/tunnel/relay) and WebRTC P2P

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

## CLI Reference

```bash
team-claude host                           # Start a session (WebRTC P2P by default)
team-claude host --tunnel cloudflare       # Remote access via Cloudflare tunnel
team-claude host --tunnel localtunnel      # Remote access via localtunnel
team-claude host --no-approval             # Trust mode — skip prompt review
team-claude host --continue                # Resume most recent Claude Code session
team-claude host --resume <id>             # Resume a specific session by ID
team-claude host --max-participants 20     # Raise participant limit (default: 10)
team-claude join <code> --password <pw>    # Join a session
team-claude join <code> … --with-claude    # Join with a private local Claude
team-claude relay                          # Run a self-hosted relay server
team-claude config                         # View/manage saved configuration
```

## In-Session Commands

| Input | Effect |
|-------|--------|
| `hello!` | Group chat |
| `@claude fix the bug` | Prompt shared Claude (all see the response) |
| `@bob check line 42` | Whisper to bob only |
| `/think what does this do?` | Private prompt to your local Claude |
| `/private <prompt>` | Alias for `/think` |
| `/agent-mode` | Enable: local Claude auto-responds to chat and whispers |
| `/agent-mode off` | Disable your own agent mode |
| `/agent-mode off <name>` | (host) Disable a participant's agent mode remotely |
| `/context-mode full\|prompt-only` | Set context Claude receives for prompts |
| `/who` | List all participants |
| `/kick <name>` | (host) Disconnect a participant |
| `/trust` | (host) Switch to trust mode (no approval) |
| `/approval` | (host) Re-enable approval mode |
| `/status` | Show session info and duration |
| `/help` | Show all available commands |

## How It Works

```
┌─────────────────────┐
│  Host               │◄── WebSocket ──► Participant A  (+ local Claude)
│  · Claude Code      │◄── WebSocket ──► Participant B  (+ local Claude)
│  · Chat server      │◄── WebSocket ──► Participant N  (+ local Claude)
│  · Approval gate    │
└─────────────────────┘
```

- **Host** runs a headless Claude Code process and a WebSocket server
- **Participants** connect via WebSocket (or WebRTC P2P for direct connections)
- **Messages** flow through the host with monotonic sequence numbers for total ordering
- **Shared Claude** prompts are approval-gated by default; the host can switch to trust mode
- **Private Claude** runs entirely on the participant's machine — responses never leave it
- **Agent mode** auto-forwards incoming chat/whispers to the participant's local Claude and posts responses back; includes shared Claude replies in context, applies rate limiting (5 s), and prevents response loops

## Security

- **E2E encrypted** — All WebSocket traffic is NaCl secretbox encrypted with a scrypt-derived key
- **Approval mode** — Host reviews participant prompts before they reach Claude (on by default)
- **Host-controlled** — Claude runs on the host's machine using the host's API key
- **Agent safeguards** — Loop prevention (`isAgentResponse` flag), 5-second rate limit, host remote-disable

## Connection Modes

| Mode | How |
|------|-----|
| **P2P (default)** | WebRTC direct connection, no server needed |
| **Cloudflare tunnel** | `--tunnel cloudflare` — works anywhere, no port forwarding |
| **localtunnel** | `--tunnel localtunnel` — quick LAN/remote sharing |
| **LAN** | Share the local IP directly on the same network |
| **Relay** | `--relay <url>` with a self-hosted relay server |

## Development

```bash
git clone https://github.com/m3nadav/team-claude.git
cd team-claude
npm install
npm run build   # compile TypeScript
npm test        # run test suite (vitest)
npm run dev     # watch mode
```

Requires Node.js 18+.

## License

[MIT](LICENSE)

Forked from [claude-duet](https://github.com/EliranG/claude-duet) by EliranG.
