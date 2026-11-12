# Agent Sandbox Platform - Build Spec

> Status: spec agreed with Satish, Nov 12, 2026. Code not started.
> Purpose: curiosity. Learn what it takes to build a platform like Agent37 (https://www.agent37.com/docs/agents-api/examples). No customer, no revenue target.
> Licence: Apache-2.0. Repository: `C:\code\agent-sandbox` (public, DeltaXY GitHub org - not yet pushed).

---

## 1. Decisions (one question at a time, Nov 12, 2026)

| # | Question | Decision |
|---|---|---|
| 1 | Which layers? | All 7: sandbox, lifecycle, routing, Agent API, streaming, files, business. |
| 2 | Isolation | Docker Sandboxes (`sbx` CLI): one microVM per sandbox. |
| 3 | Harnesses | Every harness `sbx` supports (Claude Code, Codex, Gemini CLI and others), plus Pi. |
| 4 | Extras | The whole of Agent37 is the target. Phase 1 adds templates, exec and logs, public ports, fork. Later phases add backups, crons, metrics, profiles, regions. |
| 5 | Sleep and wake | In (part of the lifecycle layer). |
| 6 | Routing | Per-sandbox subdomain, `{id}.<domain>`. Locally `{id}.localhost`. |
| 7 | Where it runs | Develop on Satish's Windows laptop. Stay cloud-independent. Experiment on DigitalOcean, Hetzner and others. |
| 8 | Language | TypeScript (Node). |
| 8b | Extra template | eve, in addition to Pi and Claude Code. |
| 9 | Phase 1 proof | The acceptance script (section 7) passes on Pi, eve and Claude Code. |
| 10 | Time box | 4 weekends. Checkpoint after weekend 2. |
| 11 | Visibility | Open source from day 1. |

---

## 2. Architecture

```
Client (curl, SDK, app)
   |  HTTPS, API key
   v
+-------------------------------------------------------------+
| Control plane (TypeScript)                                   |
|  Sandbox API   /v1/instances ...     (lifecycle, keys, meter) |
|  Router        {id}.<domain> -> sandbox                       |
|  Agent API     /v1/responses, /v1/sessions, /v1/files        |
|  Event bus     harness output -> 9 SSE events + replay buffer |
|  Meter         minutes (running / sleeping) + tokens         |
+-------------------------------------------------------------+
   |  HostProvider interface
   v
+------------------+   +------------------+   +------------------+
| LocalWindows     |   | Hetzner          |   | DigitalOcean     |
| (sbx on laptop)  |   | (sbx, needs KVM) |   | (sbx, needs KVM) |
+------------------+   +------------------+   +------------------+
   |
   v
 microVM per sandbox  <- template image (pi | eve | claude-code | codex | ...)
   inside: harness + HarnessAdapter shim + files under /home/agent
```

### The seven layers

| # | Layer | What it does | Phase 1 scope |
|---|---|---|---|
| 1 | Sandbox | Creates one isolated microVM per sandbox through `sbx`. | Create, delete, list. |
| 2 | Lifecycle | Running, sleeping, stopped. Disk survives sleep. Idle timeout puts a sandbox to sleep. A request to a sleeping sandbox wakes it. | All states in section 4. |
| 3 | Routing | Sends `{id}.<domain>` to the right sandbox: Agent API calls and public ports. | `{id}.localhost` locally. |
| 4 | Agent API | `POST /v1/responses` runs one turn of the harness. Sessions keep history. One active turn per session. Cancel. | Full. |
| 5 | Streaming | Every harness adapter emits the same 9 SSE events. Replay buffer allows reattach. | Full. |
| 6 | Files | List, read, write, move, delete, mkdir, archive inside the sandbox. | Full. |
| 7 | Business | Workspaces, API keys, per-minute metering, token metering, wallet. | Keys + meter. Wallet balance check on create. |

### Two interfaces that keep the design open

**HostProvider** - one adapter per place the platform runs.

```ts
interface HostProvider {
  name: string;                       // "local-windows" | "hetzner" | "digitalocean"
  checkSupport(): Promise<{ kvm: boolean; sbxVersion?: string; notes: string[] }>;
  createSandbox(spec: SandboxSpec): Promise<SandboxHandle>;
  stop(id: string): Promise<void>;    // used for sleep
  start(id: string): Promise<void>;   // used for wake
  fork(id: string, newId: string): Promise<SandboxHandle>;
  exec(id: string, cmd: string[]): AsyncIterable<ExecChunk>;
  publishPort(id: string, port: number): Promise<string>; // returns internal address
  delete(id: string): Promise<void>;
}
```

**HarnessAdapter** - one adapter per harness. Turns that harness's output into the common events.

```ts
interface HarnessAdapter {
  agent: "pi" | "eve" | "claude-code" | "codex" | "gemini" | string;
  startTurn(input: TurnInput): AsyncIterable<AgentEvent>; // AgentEvent = one of the 9 events
  cancel(responseId: string): Promise<void>;
  nativeSessionId?(sessionId: string): string | undefined; // some harnesses issue their own
}
```

Adding a cloud means adding one HostProvider. Adding a harness means adding one HarnessAdapter and one template.

---

## 3. API surface (mirrors Agent37 shapes)

### Sandbox API - `https://api.<domain>/v1`, header `Authorization: Bearer <key>`

| Method | Path | Phase |
|---|---|---|
| POST | `/v1/instances` (template, resources, env, idle_timeout_seconds, public_ports, metadata) | 1 |
| GET | `/v1/instances`, `/v1/instances/{id}` | 1 |
| POST | `/v1/instances/{id}/stop`, `/start`, `/sleep`, `/restart` | 1 |
| POST | `/v1/instances/{id}/fork` | 1 |
| POST | `/v1/instances/{id}/exec` | 1 |
| GET | `/v1/instances/{id}/logs` | 1 |
| DELETE | `/v1/instances/{id}` | 1 |
| GET | `/v1/usage` (minutes, tokens, cost per instance) | 1 |
| POST/GET | `/v1/instances/{id}/backups` | 2 |
| POST/GET | `/v1/instances/{id}/crons` | 2 |
| GET | `/v1/instances/{id}/metrics` | 2 |

### Agent API - `https://{id}.<domain>/v1`, header `X-Agent-Key: <key>`

| Method | Path | Notes |
|---|---|---|
| POST | `/v1/responses` | `input`, `files`, `session_id`, `stream`, `model`, `agent`, `metadata`. A failed turn returns HTTP 200 with `status: "failed"`. A second turn on a busy session returns `409 session_busy`. |
| POST | `/v1/responses/{id}/cancel` | Does not roll back side effects. |
| GET | `/v1/responses/{id}/stream` | Reattach and replay. |
| GET/PATCH/DELETE | `/v1/sessions`, `/v1/sessions/{id}` | First `/responses` without `session_id` creates the session. |
| GET/PUT/DELETE/PATCH | `/v1/files`, `/v1/files/content`, `/v1/files/archive`, `/v1/files/dir` | `PUT` supports `X-Expected-Mtime` (412 on conflict). |
| GET | `/v1/health`, `/v1/models`, `/v1/version` | `healthy: true` only when the harness is ready, not just the VM. |

### The 9 SSE events (every adapter must emit exactly these)

`response.created`, `response.reasoning.delta`, `response.output_text.delta`, `response.tool_call.generating`, `response.tool_call.started`, `response.tool_call.completed`, `response.tool_call.failed`, `response.completed`, `response.failed`.

Keepalive comment every 30 s. No `[DONE]` sentinel. Replay buffer per response; record kept 30 minutes.

---

## 4. Lifecycle states

`provisioning -> running -> sleeping -> waking -> running`
`running -> stopping -> stopped -> starting -> running`
Any state -> `failed`. `deleting -> deleted`.

- Sleep = stop the microVM, keep the disk. Meter only disk.
- Wake = any request to `{id}.<domain>` while `sleeping`. The router holds the request until `/v1/health` is healthy.
- Idle timeout default 900 s (range 300-86400).

---

## 5. Templates

| Template | Phase | Contents |
|---|---|---|
| `claude-code` | 1 | Claude Code + adapter shim (stream-json output -> 9 events). |
| `pi` | 1 | Pi coding agent + adapter shim. |
| `eve` | 1 | eve runtime. The user sends an eve agent project; the shim runs it and maps eve events to the 9 events. |
| `codex`, `gemini`, other `sbx` harnesses | 2 | One adapter each. |
| `base` | 1 | Plain Linux, no agent. Exec only. |
| Custom Dockerfile | 2 | User-supplied image. |

---

## 6. Phases and time box

| When | Target |
|---|---|
| Weekend 1 | `sbx` on Windows driven from Node: create, exec, delete. Claude Code template. `/v1/responses` non-streaming. Repo public with README, AGENTS.md, this spec. |
| **Weekend 2 - checkpoint** | **One template passes acceptance steps 1-5.** If not: decide to continue, switch to Docker + gVisor, or stop. |
| Weekend 3 | Pi and eve adapters. Fork, sleep and wake, public ports. Keys and meter. |
| Weekend 4 | All three templates pass the full acceptance script. First cloud experiment (KVM check on Hetzner and DigitalOcean). |
| Phase 2 | Remaining `sbx` harnesses, backups, crons, metrics, profiles, regions, custom images, wallet. |

---

## 7. Phase 1 acceptance script (the definition of done)

Run steps 1-10 on each of **Pi, eve and Claude Code**. Then run step 11 once.

1. Create a sandbox from the template.
2. Send a streamed turn: "write hello.py that prints hello, then run it". Receive the 9-event sequence ending in `response.completed`.
3. Start a second streamed turn. Disconnect halfway. Reattach via `/v1/responses/{id}/stream` and receive the rest with no gap and no duplicate.
4. Read `hello.py` through the files API.
5. Run `ls /home/agent` through exec and see `hello.py`.
6. Ask the agent to start a web server on port 8080. Open `http://{id}.localhost` and get a response.
7. Fork the sandbox. The fork has `hello.py` and the full session history.
8. Put the original to sleep. Send a message. It wakes, and the session continues with the earlier history.
9. Using a key from a second workspace, try to read the first workspace's files. Get 401 or 404. From inside the second sandbox, try to reach the first sandbox over the network. Get refused.
10. `/v1/usage` shows running minutes, sleeping minutes and tokens for the sandbox.
11. **Cross-check:** send the same prompt to all three templates. Event names and field shapes are identical; all three produce a working `hello.py`.

Phase 1 is done only when all 3 x 10 checks and the cross-check pass.

---

## 8. What `sbx` v0.50.1 already answers (help text read Nov 12, 2026)

Installed on Satish's laptop: `sbx version v0.50.1`. These are read from `sbx --help`, not yet tested by running.

| Need | What `sbx` offers | Status |
|---|---|---|
| Drive from Node | `sbx ls --json` (or `--format json`). `sbx exec` behaves like `docker exec` and returns the command's exit status (125 = sbx could not run it). `sbx run --detach` prints the sandbox ID. | Looks drivable. Test. |
| Sleep and wake | `sbx stop` keeps state. `sbx exec` on a stopped sandbox starts it first. `sbx ports --publish` also starts a stopped sandbox. | Good fit. Test that the disk and agent session survive. |
| Fork | No fork or clone command. `sbx template save` snapshots a sandbox as a template; `sbx run -t TAG` creates a new one from it. | Fork = template save + create. Test speed and size. |
| Public ports | `sbx ports --publish [[HOST_IP:]HOST_PORT:]SANDBOX_PORT`. Binds to loopback with an ephemeral port by default. | Router proxies `{id}.localhost` to the published loopback port. |
| Built-in agents | claude, codex, copilot, cursor, devin, docker-agent, droid, gemini, kiro, opencode, shell. | **Pi and eve are not built in.** Build them as sandbox kits (local directory, ZIP, git repo or OCI reference) or on the `shell` agent. |
| Templates | Sandbox kits (`sbx create AGENT|KIT`) plus saved templates (`sbx template save/load/ls`). | Platform templates map to kits. |
| Files | `sbx cp` between host and sandbox. | Files API can use `sbx exec` for listing and `sbx cp` for content. |
| Agent turns | `sbx exec SANDBOX <harness command>`. Claude Code: `claude -p ... --output-format stream-json`. | Adapter runs the harness non-interactively through exec. Test. |
| Hosted option | `--cloud` dispatches to Docker Cloud Sandboxes (cloud `stop` suspends memory + disk; billable sizes; TTL). | Docker sells the hosted layer itself. Treat as one more `HostProvider` and as a comparison point. |

### Still open (answer by running code)

| # | Question | How to answer |
|---|---|---|
| 1 | Does a stopped local sandbox keep the agent's session files and installed packages? | Stop, exec, compare. |
| 2 | How long do `template save` and create-from-template take locally? Is fork fast enough to be useful? | Time it. |
| 3 | Can Pi and eve run as kits? | Build a minimal kit for each. |
| 4 | Do Docker's terms allow running local `sbx` as a hosted multi-tenant service? | Read Docker's terms before any public hosting. |
| 5 | Do Hetzner cloud VMs or DigitalOcean droplets expose KVM for local-mode `sbx` on Linux? | Smallest VM, `ls /dev/kvm`, `sbx diagnose`. Fallback: bare metal. |
| 6 | Does `sbx` microVM mode work on Linux at all? | Sources conflict. `sbx setup` and `sbx diagnose` on a real box. |

---

## 9. Not yet decided (defaults in use)

| Item | Default until Satish decides |
|---|---|
| Project name | `agent-sandbox` (placeholder) |
| Licence | Decided (Nov 12): Apache-2.0 |
| GitHub org | DeltaXY org |
| Domain for hosted experiments | None until the cloud experiment |

---

## 10. Docs in this repo

`README.md`, `AGENTS.md` (for coding agents), `docs/SPEC.md` (this file), `docs/TESTING.md` (section 7 as a checklist; becomes an executable script). Linting config instead of a style doc. `docs/ARCHITECTURE.md` after weekend 2.

---

## 11. Related

- Agent37 docs: https://www.agent37.com/docs/agents-api/examples (concepts, chat, streaming, sessions, files pages read Nov 12, 2026)
- `projects/agentOS.md` - earlier isolation research (V8 isolates; not chosen because native binaries likely do not run)
- Docker Sandboxes: https://www.docker.com/blog/docker-sandboxes-vs-containers/ and https://www.docker.com/blog/comparing-sandboxing-approaches-ai-agents/
