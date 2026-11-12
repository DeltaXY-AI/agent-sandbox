# agent-sandbox

An open-source platform that gives every AI agent its own isolated computer, behind one API.

Send a message to `POST /v1/responses`. The platform runs the agent (Claude Code, Pi, eve, Codex, Gemini CLI and others) inside its own Docker Sandboxes microVM, streams the result as server-sent events, and keeps the session, the files and the disk between turns.

**Status:** weekend 1 working: Sandbox API and non-streaming agent turns on fx, locally on Windows. Built in the open, one weekend at a time.

## Why this exists

To learn what it takes to build a hosted agent platform like [Agent37](https://www.agent37.com/docs/agents-api/examples): sandboxes, lifecycle, routing, a common Agent API, streaming, files, and metering. Every layer, built from scratch, with the failures written down.

## What it will do (Phase 1)

| Layer | What it does |
|---|---|
| Sandbox | One microVM per sandbox, through Docker Sandboxes (`sbx`). |
| Lifecycle | Create, sleep, wake, stop, fork, delete. The disk survives sleep. |
| Routing | `{id}.localhost` reaches the right sandbox and its published ports. |
| Agent API | `/v1/responses`, `/v1/sessions`. One active turn per session. Cancel. |
| Streaming | Every harness emits the same 9 SSE events. Disconnect and reattach without losing events. |
| Files | List, read, write, move and delete files in the sandbox. |
| Business | Workspaces, API keys, per-minute and per-token metering. |

Templates in Phase 1: **fx, Pi, eve, Claude Code**. Weekend 1 uses fx through the Vercel AI Gateway to keep model cost low. More harnesses in Phase 2.

## Requirements

- Docker Sandboxes CLI (`sbx`). Tested with v0.50.1 on Windows 11.
- Node.js 24 or later (runs TypeScript directly).
- Linux hosts need KVM.

## Docs

- [docs/SPEC.md](docs/SPEC.md) - the full build spec and decisions.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) - components, request flows and the two adapter interfaces.
- [docs/PRD.md](docs/PRD.md) - what the product is, who it is for, and what Phase 1 includes.
- [docs/TESTING.md](docs/TESTING.md) - the acceptance script that defines "done".
- [AGENTS.md](AGENTS.md) - instructions for coding agents working in this repo.

## Licence

Apache-2.0. See [LICENSE](LICENSE).
