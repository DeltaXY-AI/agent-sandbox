# PRD - agent-sandbox

> Status: Phase 1 acceptance passed, Nov 13, 2026. Owner: Satish.
> Sources: Agent37 docs (read Nov 12, 2026), `sbx` v0.50.1 help text (read, not yet run), `docs/SPEC.md`.
> Where this file and `docs/SPEC.md` disagree on a decision, the spec wins. Phase decisions for features the spec did not cover were made by Satish on Nov 12, 2026 (section 3.10).

---

## 1. What we are building

**A sandbox for agents: one isolated computer per AI agent, behind one HTTP API.**

A client creates a sandbox, sends a message, and gets a streamed reply. Inside the sandbox an agent harness (Claude Code, Pi, eve, Codex, ...) runs with its own disk, its own processes and its own network policy. The sandbox sleeps when idle, wakes on the next request, and keeps its files and session history across both.

This is the product Agent37 sells (https://www.agent37.com). We rebuild it in the open, layer by layer, on top of **Docker Sandboxes (`sbx`)**, to learn what each layer costs. There is no customer and no revenue target.

### Why now: Docker Sandboxes

Docker released Docker Sandboxes, driven by the `sbx` CLI. It runs each AI agent in its own microVM with its own kernel, and it does that on a laptop. Before this, the isolation layer was the hardest part of an agent platform to build. `sbx` gives us that layer, plus much of the lifecycle, so our work moves up to the parts Agent37 adds on top: one API, one event stream, routing, sleep and wake, and metering.

What `sbx` v0.50.1 gives us (from help text, to be confirmed by running it):

| `sbx` feature | Command | What it gives the platform |
|---|---|---|
| microVM per sandbox | `sbx create AGENT\|KIT` | Isolation. Own kernel per sandbox (stronger than Agent37's gVisor). |
| Built-in agents | claude, codex, copilot, cursor, devin, docker-agent, droid, gemini, kiro, opencode, shell | Harnesses we do not have to package. Pi and eve are not built in. |
| Sandbox kits | `sbx kit pack/push/pull/sign`, local dir, ZIP, git, OCI | Our own templates (Pi, eve, base). |
| Saved templates | `sbx template save/load/ls` | Snapshots. The basis for fork. |
| Sizing | `--cpus`, `--memory` | Instance resources. No disk-size flag. |
| Machine output | `sbx ls --json`, `sbx stop --json` | Drivable from Node. |
| Exec | `sbx exec` (like `docker exec`, exit 125 = sbx failed) | Exec API, files API, and running harness turns. |
| Stop keeps state | `sbx stop`; `sbx exec` on a stopped sandbox starts it | Sleep and wake. |
| Ports | `sbx ports --publish`, `-p` on create | Public ports, behind our router. Binds loopback only. |
| Copy files | `sbx cp` | File upload and download. |
| Env vars | `-e`, `--env-file` | Instance `env`. |
| Network policy | `sbx policy allow/deny network`, `--deny-network` | Instance `network` allow and deny lists. |
| Secrets | `sbx secret set/import` | Harness API keys (Anthropic, OpenAI) without putting them in env. |
| MCP servers | `sbx mcp add/load`, `--static-mcp` | Tool integrations per sandbox. |
| Skills | `--skills` | Shared skills store per agent. |
| Cloud mode | `--cloud` (Docker Cloud Sandboxes: suspend memory + disk, public port URLs, TTL, volumes) | A second `HostProvider`, and a comparison point. |

What `sbx` does not give us, so we build it: the HTTP API, routing by subdomain, the common event stream, sessions, idle detection, logs, metrics, backups, crons, API keys, workspaces and metering.

---

## 2. Users

| User | What they do |
|---|---|
| Developer calling the API (curl, SDK, app) | Creates sandboxes, chats with the agent, streams events, reads and writes files, runs commands, reads usage. |
| Operator (Satish) | Runs the control plane on a Windows laptop, later on Hetzner or DigitalOcean, without changing code outside a `HostProvider`. |
| Coding agents in this repo | Build against `AGENTS.md` and `docs/TESTING.md`. |

---

## 3. Agent37 feature inventory, and how we bring each one in

Every Agent37 feature from its docs, mapped to the `sbx` primitive we build on (or "ours" when `sbx` has nothing) and the phase. Phase comes from `docs/SPEC.md`. Phases for Agent37 rows the spec did not mention were decided by Satish on Nov 12, 2026.

### 3.1 Instances (Sandbox API, `Authorization: Bearer`)

| Agent37 feature | How we build it | Phase |
|---|---|---|
| `POST /v1/instances` with `template`, `resources`, `env`, `idle_timeout_seconds`, `public_ports`, `metadata`, `name` | `sbx create KIT --name {id} --cpus --memory -e ... -p ...`. Our record holds metadata and the idle timeout. | 1 |
| `GET /v1/instances`, `GET /v1/instances/{id}` | Our record, reconciled with `sbx ls --json`. | 1 |
| `DELETE /v1/instances/{id}` | `sbx rm`. | 1 |
| `PATCH` instance (name, metadata, env, auto-sleep) | Ours for metadata; env needs a restart. | 2 |
| `resources.disk` | No `sbx` flag. | 2 |
| `type`: default / performance / vm | `sbx` is always a microVM. | 2 |
| `region`: us / eu / ap-south | One region per `HostProvider`. | 2 |
| `mount_path` | Kit config. | 2 |
| `budget` per instance | Ours. | 2 |

### 3.2 Lifecycle

| Agent37 feature | How we build it | Phase |
|---|---|---|
| States: provisioning, running, stopping, stopped, starting, sleeping, waking, failed, deleting, deleted | Our state machine over `sbx` status (spec section 4). | 1 |
| `stop` / `start` | `sbx stop`; start via `sbx run --detach --name {id}`. | 1 |
| `sleep`, auto-sleep after idle (300-86400 s, default 900) | Router tracks last byte per sandbox; on timeout `sbx stop`. | 1 |
| Wake on any request; edge holds the request; `503 wake_timeout` | Router holds the request, starts the sandbox, waits for `/v1/health`. | 1 |
| `restart` | `sbx stop` + start. | 1 |
| `update` (new template image, keep data) | No `sbx` equivalent. | 2 |
| `resize` | No `sbx` equivalent after create. | 2 |
| `past_due` suspend on negative balance | Our meter calls sleep. | 2 (wallet) |

### 3.3 Templates and harnesses

| Agent37 feature | How we build it | Phase |
|---|---|---|
| `agent37-base` (plain Linux, no agent) | `sbx` `shell` agent. | 1 |
| fx (not in Agent37) | Our saved template: fx 0.0.16 + turn relay. | 1 |
| `agent37-pi` | Our saved template: Pi 1.5.2 (no kit needed). | 1 |
| eve (not in Agent37) | Our saved template: eve on Node 24 + default project. | 1 |
| `agent37-claude-code` | `sbx` built-in `claude` + adapter shim. Left Phase 1 (SPEC decision 35). | 2 |
| `agent37-codex`, `agent37-opencode` | `sbx` built-ins + adapter. | 2 |
| Gemini, Copilot, Cursor, Droid, Kiro (not in Agent37) | `sbx` built-ins + adapter. | 2 |
| `agent37-hermes`, `agent37-openclaw`, `agent37-grok`, `agent37-n8n`, `agent37-ubuntu`, `agent37-android` | Not built into `sbx`; each needs a kit. | 2 |
| Version pinning (`name@tag`) | Kit OCI tags. | 1 |
| Custom images, workspace templates | `-t IMAGE`, `sbx kit pack/push`. | 2 |
| `agent` per request (route a turn to a harness) | `HarnessAdapter` lookup; `agent_unavailable` if not installed. | 1 |
| Profiles (Hermes only) | Comes with the Hermes template. | 2 |

### 3.4 Routing and network

| Agent37 feature | How we build it | Phase |
|---|---|---|
| `https://{id}.agent37.app` serves the Agent API | Our router: `{id}.localhost` to the sandbox's published API port. | 1 |
| `https://{id}-{port}.agent37.app` for any port | Router parses `{id}-{port}` and proxies to the port published with `sbx ports --publish`. | 1 |
| `public_ports` (unauthenticated URLs for webhooks) | Router + `sbx ports --publish`. | 1 |
| Signed browser URLs | Ours. | 1 |
| Custom domains | Ours. | 1 |
| `network`: allow-all / deny-all / allow list | `sbx policy allow/deny network`, `--deny-network`. | 1 |
| No sandbox can reach another | microVM isolation; checked by acceptance step 9. | 1 |
| SSH (ssh, scp, VS Code Remote) | No `sbx` SSH. Ours: an SSH gateway that forwards to `sbx exec -it`. | 1 |

### 3.5 Agent API (`https://{id}.<domain>/v1`, `X-Agent-Key`)

All ours. `sbx` only gives us `exec` to run the harness.

| Agent37 feature | How we build it | Phase |
|---|---|---|
| `POST /v1/responses`: `input`, `files`, `session_id`, `stream`, `model`, `agent`, `metadata` | Control plane runs the harness through `sbx exec` via its adapter. | 1 |
| `reasoning_effort` with per-harness mapping | Adapter maps the level. | 1 |
| Failed turn = HTTP 200 with `status: "failed"` | Ours. | 1 |
| One active turn per session, `409 session_busy` | Session lock in the control plane. | 1 |
| `POST /v1/responses/{id}/cancel`; ends with status `cancelled` | Adapter kills the exec'd process. | 1 |
| Non-streaming: headers first, whitespace tick every 25 s | Ours. | 1 |
| Sessions: list, read (with `active_response_id`), rename, delete | Ours, mapped to each harness's native session id. | 1 |
| `GET /v1/models`, `/v1/health`, `/v1/version` | Adapter reports models; health = harness ready, not just VM. | 1 |
| Request cap 2 MB (`413`), metadata 16 pairs / 64 KB | Ours. | 1 |

### 3.6 Streaming

| Agent37 feature | How we build it | Phase |
|---|---|---|
| Exactly 9 SSE events (`response.created` ... `response.failed`) | Every `HarnessAdapter` maps native output to these 9. | 1 |
| `:keepalive` every 30 s, no `[DONE]` | SSE writer. | 1 |
| Reattach: `GET /v1/responses/{id}/stream` replays then follows | Replay buffer per response, kept 30 min. | 1 |
| Buffer limits (100,000 events, 1,000 records) | Ours. | 1 |

### 3.7 Files

| Agent37 feature | How we build it | Phase |
|---|---|---|
| List, read, write, move, delete, mkdir, archive | `sbx exec` for listing and moves; `sbx cp` for content. | 1 |
| `PUT /v1/files/content` with `X-Expected-Mtime` (412) | `stat` through exec before write. | 1 |

### 3.8 Operations

| Agent37 feature | How we build it | Phase |
|---|---|---|
| Exec | `sbx exec`, stream stdout/stderr and exit code. | 1 |
| Logs (boot and runtime) | No `sbx logs`. Ours: capture lifecycle and harness output. | 1 |
| Fork (independent copy, own id and URLs) | `sbx template save` + `sbx create -t`. Speed unknown (spec section 8, open question 2). | 1 |
| Backups: create, list, restore, automatic daily | `sbx template save` or archive via `sbx cp`. | 2 |
| Crons (scheduled message wakes the sandbox, runs a turn, sleeps) | Our scheduler calls `/v1/responses`. | 2 |
| Metrics (CPU, memory, disk history) | No `sbx` metrics. | 2 |

### 3.9 Business

| Agent37 feature | How we build it | Phase |
|---|---|---|
| Workspaces and API keys (`sk_live_`) | Ours. | 1 |
| Meter: running minutes, sleeping (disk) minutes, tokens | Ours, from state timestamps and harness `usage`. `GET /v1/usage`. | 1 |
| Create gate: one day of compute in the wallet, else `402` | Ours. | 1 (balance check only) |
| Prepaid wallet, top-ups, per-minute charges | Ours. | 2 |
| Instance limits by spend tier | Ours. | 2 |
| Members (invite people to a workspace) | Ours. | 2 |
| `POST /v1/signup` | Ours. | 2 |
| Stable error codes on both APIs | Ours, copying Agent37 codes. | 1 |

### 3.10 Services, integrations and tooling (decided Nov 12, 2026)

| Agent37 feature | How we build it | Phase |
|---|---|---|
| Bring your own model key (Anthropic, OpenAI, ...) | `sbx secret set`; the key never enters the repo or the instance record. | 1 |
| Bring your own Composio key | `sbx secret` + `sbx mcp add/load`. | 1 |
| Managed services: LLM router, Brave Search, Composio, Perflo, billed from the wallet | Ours. Needs the wallet and per-instance budgets. | 2 |
| Headless browser inside the sandbox | Installed in the template kits. | 1 |
| Watchable desktop | Ours. | 2 |
| App integrations (Gmail, Slack, Notion via Composio) | `sbx mcp`. | 2 |
| Messaging channels (Telegram, WhatsApp, Slack, Discord) | Public ports + adapters. | 2 |
| TypeScript client SDK | Ours. The acceptance script uses it. | 1 |
| Python SDK, starter kit, white-label dashboard | Ours. | 2 |
| Outside agent loops using our sandbox (Claude Managed Agents, Cursor Cloud Agents, OpenAI Agents SDK, LangChain) | Exec + files API as their tool backend. | 2 |

---

## 4. Where we differ from Agent37 on purpose

| Area | Agent37 | agent-sandbox |
|---|---|---|
| Isolation | gVisor | microVM per sandbox (`sbx`) |
| Where it runs | Their cloud | Laptop first, then any host with KVM, through `HostProvider` |
| Source | Closed | Open source, Apache-2.0 |
| Extra harness | - | eve |
| Agent key header | `X-Agent37-Key` | `X-Agent-Key` |

---

## 5. Success criteria

Phase 1 is done when `docs/TESTING.md` passes: steps 1-10 on fx, Pi and eve, plus the cross-check. The checkpoint at the end of weekend 2 is steps 1-5 on one template.

**Met Nov 13, 2026:** every check passes on fx, Pi and eve. Still to build in Phase 1 scope (not tested by the script): file writes (PUT, DELETE, PATCH, dir, archive), cancel, WebSocket proxying, user-supplied eve projects, bring-your-own model keys, and the Phase 1 extras of decisions 13, 14 and 17-19.

## 6. Risks

| Risk | Effect | How we find out |
|---|---|---|
| A stopped local sandbox loses agent session files or packages. | Sleep and wake breaks. | Stop, exec, compare (spec 8, Q1). |
| `template save` is slow or large. | Fork and backups are not useful. | Time it (spec 8, Q2). |
| Pi and eve do not run as kits. | Two of the three Phase 1 templates fail. | Build minimal kits (spec 8, Q3). |
| Cloud VMs have no KVM. | Cloud needs bare metal or `--cloud`. | `ls /dev/kvm` on the smallest VM (spec 8, Q5). |
| Docker's terms forbid hosting local `sbx` for others. | No public hosted service. | Read the terms (spec 8, Q4). |
| `sbx` has no logs, metrics or disk sizing. | We build more than expected. | Already known; tracked in section 3. |
