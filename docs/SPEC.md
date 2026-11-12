# Agent Sandbox Platform - Build Spec

> Status: spec agreed with Satish, Nov 12, 2026. Code not started.
> Purpose: curiosity. Learn what it takes to build a platform like Agent37 (https://www.agent37.com/docs/agents-api/examples). No customer, no revenue target.
> Licence: Apache-2.0. Repository: `C:\code\agent-sandbox` (public, https://github.com/DeltaXY-AI/agent-sandbox).

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
| 12 | Instance ops (PATCH, update, resize, disk size, mount_path, types) | Phase 2. |
| 13 | Network and access (per-port URLs, network allow/deny, signed URLs, custom domains, SSH) | Phase 1. |
| 14 | Agent API details (reasoning_effort, request limits, replay buffer limits, version pinning) | Phase 1. |
| 15 | Accounts (per-instance budgets, instance limits, members, signup) | Phase 2. |
| 16 | Extra templates (Hermes + profiles, OpenClaw, Grok, n8n, Ubuntu VM, Android VM) | Phase 2. |
| 17 | Services | BYO model and Composio keys in Phase 1. Managed services (LLM router, Brave, Composio, Perflo) in Phase 2. |
| 18 | Integrations | Headless browser in Phase 1. Desktop, app integrations, messaging channels in Phase 2. |
| 19 | Tooling | TypeScript SDK in Phase 1. Python SDK, starter kit, white-label, outside agent loops in Phase 2. |
| 20 | Weekend 1 harness (Nov 12) | fx (Vercel Labs coding agent, https://github.com/vercel-labs/fx) instead of Claude Code, to keep model cost low. Claude Code moves later. fx joins the harness list. |
| 21 | Model access (Nov 12) | Vercel AI Gateway, one key (`AI_GATEWAY_API_KEY`). Default model `deepseek/deepseek-v4.1-flash`, set by config, overridable per request. The key reaches the sandbox only through `sbx secret set-custom` (the VM sees a placeholder). |
| 22 | Stack (Nov 12) | Node 24 (runs `.ts` directly), Hono 4 + `@hono/node-server`, zod 4, TypeScript 7 (`tsc --noEmit`), Vitest 5, ESLint + Prettier. State in memory until a store is needed. |
| 23 | Base distro (Nov 12) | Ubuntu (the `sbx` `shell` image). Alpine is a later measured experiment. |
| 24 | Weekend 2 checkpoint template (Nov 12) | fx. Acceptance steps 1-5 (streaming, reattach, files API) are built and proven on fx. Pi, eve and Claude Code are added later as adapters on top of the same features; decision 9 still defines the Phase 1 proof. |
| 25 | Deployment (Nov 12) | Immutable: `deploy/cloud-init.yaml` (cloud-independent host recipe, no secrets) plus one script per cloud (`scripts/deploy-do.ts`). Every deploy builds a new server, tests it, then retires the old one. Secrets go over SSH after boot. |
| 26 | Sandbox engine (Nov 12) | `sbx` is the engine for building and testing only (internal use; see section 8, Docker's terms). Before any external customer, a Firecracker-class `HostProvider` replaces it, chosen by a spike (Firecracker directly, E2B self-hosted, Docker + gVisor). New lifecycle features are written against the `HostProvider` interface, not `sbx` details. |
| 27 | Fork (Nov 12) | Moves after the engine switch: Firecracker snapshots (memory and disk) do it better than `sbx template save`. Acceptance step 7 waits for it. |
| 28 | Idle timeout (Nov 12) | 15 minutes by default. |
| 29 | Ports (Nov 12) | Agent37's model. Preview URL `{id}-{port}.<domain>` for any port, no registration, needs a credential: the API key (`Authorization: Bearer`), that instance's `X-Agent-Key`, or a signed URL. `public_ports` give permanent unauthenticated URLs (`{prefix}-{id}` or a 20-character slug) for webhooks. The bare `{id}.<domain>` stays the Agent API, so acceptance step 6 opens the preview URL. WebSockets come after step 6. |

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
| GET/POST/DELETE | `/v1/instances/{id}/public-ports[/{port}]` (`{port, prefix?, label?}`; at most 50; `409 public_port_exists`) | 1 |
| POST | `/v1/instances/{id}/signed-url` (`{port, ttl_seconds}`, default 3600, clamped to 60-604800; returns `{url, port, expires_at}`) | 1 |
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

Payloads follow Agent37's streaming docs (`response.created {id, session_id}`, deltas `{text}`, tool events `{tool, ...}`, `response.completed {output_text, usage, context, reasoning_effort}`, `response.failed {error}`). Each frame also carries an SSE `id:` (1, 2, 3, ... per response). Reattach without a `Last-Event-ID` header replays everything (Agent37 behaviour); with it, only later events are sent, so a client resumes with no gap and no duplicate (TESTING.md step 3). Agent37 documents no resume mechanism; `id:` and `Last-Event-ID` are the SSE standard and add no events.

---

## 4. Lifecycle states

`provisioning -> running -> sleeping -> waking -> running`
`running -> stopping -> stopped -> starting -> running`
Any state -> `failed`. `deleting -> deleted`.

- Sleep = stop the microVM, keep the disk. Meter only disk.
- Wake = any request to `{id}.<domain>` while `sleeping`. The router holds the request until `/v1/health` is healthy.
- Idle timeout default 900 s (range 300-86400).
- Idle = no work in flight (running turn, open stream, exec or files call) and no authenticated request for `idle_timeout_seconds`. A sweep every 30 s sleeps idle instances.
- Sleeping and stopped differ (Nov 12, 2026): a sleeping instance wakes on any authenticated request (agent host, exec, files) and on `/start`; a stopped instance stays off until `/start`, and requests get `409 instance_stopped`. A wake that takes longer than 3 minutes answers `503 wake_timeout` (Agent37's code).
- `HostProvider.sleep` / `wake`: on sbx they are `stop` / auto-start (sbx has no pause); a Firecracker host would snapshot and restore (decision 26).

---

## 5. Templates

| Template | Phase | Contents |
|---|---|---|
| `fx` | 1 | `shell` sandbox + fx 0.0.16 in `/usr/local/bin` + `templates/fx/` (gateway relay, `fx-turn.sh`), saved as `sbx` template `agent-sandbox-fx:0.0.16`. Rebuild with `scripts/build-fx-template.ts`. Adapter runs `fx ask --json`; streaming later through ACP (`fx acp`). |
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
| Weekend 1 | `sbx` on Windows driven from Node: create, exec, delete. Sandbox API (`/v1/instances`, exec, stop, start) on the `base` template. fx template. `/v1/responses` non-streaming on fx. Demo: Agent37's "first agent message" and a hello.py turn. Repo public with README, AGENTS.md, this spec. |
| **Weekend 2 - checkpoint** | **One template passes acceptance steps 1-5.** If not: decide to continue, switch to Docker + gVisor, or stop. **Passed on fx, Nov 12, 2026** (`npm run acceptance`). |
| Weekend 3 | Pi and eve adapters. Sleep and wake, public ports. Keys and meter. (Fork moves after the engine switch, decision 27.) |
| Weekend 4 | All three templates pass the full acceptance script. First cloud experiment (KVM check on Hetzner and DigitalOcean). |
| Phase 2 | Remaining `sbx` harnesses, backups, crons, metrics, profiles, regions, custom images, wallet. Decisions 12, 15, 16 and the Phase 2 parts of 17-19. |
| Not yet placed in a weekend | Phase 1 additions from decisions 13, 14 and the Phase 1 parts of 17-19. |

---

## 7. Phase 1 acceptance script (the definition of done)

Run steps 1-10 on each of **Pi, eve and Claude Code**. Then run step 11 once.

1. Create a sandbox from the template.
2. Send a streamed turn: "write hello.py that prints hello, then run it". Receive the 9-event sequence ending in `response.completed`.
3. Start a second streamed turn. Disconnect halfway. Reattach via `/v1/responses/{id}/stream` and receive the rest with no gap and no duplicate.
4. Read `hello.py` through the files API.
5. Run `ls /home/agent` through exec and see `hello.py`.
6. Ask the agent to start a web server on port 8080. Open the preview URL `http://{id}-8080.localhost` (with the key or a signed URL) and a public port URL, and get a response.
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

### Tested by running (sbx v0.50.1, Windows 11, Nov 12, 2026)

| Test | Result |
|---|---|
| `sbx create shell --name X --no-progress` (no workspace path) | 7.8 s. Ubuntu 26.04.1, kernel 7.0.14, user `agent`, `HOME=/home/agent`, cwd `/home/agent/workspace`. 20 GB root overlay; a fresh sandbox uses 46 MB. Node, Python 3, git, curl preinstalled. |
| `sbx ls --json` | JSON array. Fields: `name`, `id` (UUID), `agent`, `status` (`running`, `stopped`), `last_used_at`, `created_at`, `workspaces` (only when a path was given). |
| `sbx exec X cmd` | 0.4 s on a running sandbox. Returns the command's exit status (`exit 7` gives 7). |
| Exec of a command missing inside the VM | Exit 127 plus `OCI runtime exec failed: ...` on stderr. Not 125. |
| Exec on a sandbox that does not exist | Exit 125, `Error: sandbox 'X' not found`. |
| Exec on a stopped sandbox | Starts it first (2.2-2.8 s total). The `sandbox X - started` line goes to stderr; stdout holds only the command output. |
| Start a stopped local sandbox | There is no local `sbx start` command. Start = `sbx exec X true`. |
| `sbx create` output | No `--json` flag. Look the sandbox up by name with `sbx ls --json` afterwards. |
| File written to `/home/agent`, then `stop`, then exec | File is still there. `stop` 0.8 s, `rm --force` 1.0 s. |
| Git Bash on Windows | Rewrites `/opt/...` style arguments to Windows paths before `sbx` sees them. Use `MSYS_NO_PATHCONV=1` in Git Bash. Node `spawn` is not affected. |
| Sandbox network | Every sandbox has `HTTPS_PROXY=http://gateway.docker.internal:3128` and the proxy CA installed. Direct outbound HTTPS (not through the proxy) also works under the default policy. |
| `sbx secret set-custom --sandbox X --placeholder P` | Proxy swaps placeholder `P` for the real key on requests to `--host`, only for clients that use the proxy (curl: yes). Setting it on an existing sandbox does not set the env var inside; pass `--env NAME=P` on exec. `sbx rm X` deletes the sandbox-scoped secret. |
| fx 0.0.16 and the proxy | fx (Zig binary) ignores `HTTPS_PROXY` and connects directly, so the key swap does not happen (HTTP 401). Fix: undocumented `FX_GATEWAY_BASE_URL` + `FX_GATEWAY_CHAT_URL` point fx at a relay on loopback inside the VM (Node fetch with `NODE_USE_ENV_PROXY=1`), which goes through the proxy. Since weekend 2 the relay lives in `templates/fx/fx-turn.mjs`, one per turn on an ephemeral port, and also reports the stream. Verified: the real key is not in the VM env or files. |
| `sbx template save X TAG` | On a running sandbox it asks for confirmation and fails without a TTY (the `--force` it suggests does not exist). On a stopped sandbox it saves without asking: 4.2 s. |
| `sbx create shell --template TAG --pull never` | 4.5 s from the saved fx template (faster than the 7.8 s base create). First fx turn on it: 3.0 s. |
| `{id}.localhost` on Windows | curl and browsers resolve it to 127.0.0.1. Node `dns.lookup` and `fetch` do not (ENOTFOUND); Node clients must send the `Host` header. |
| Idle auto-stop | A local sandbox with no open exec stops by itself about 30 s after the last exec ends (measured: 35 s idle; a 75 s `sleep` exec held it up until 105 s). No `sbx settings` key or `create` flag changes it (`--ttl` is cloud only). It also kills anything the agent left running, such as a web server. Fix: `LocalWindowsHost` keeps one `sbx exec <name> sleep infinity` open while a sandbox should be awake and kills it on sleep, stop and delete, so the platform's idle timer decides. |
| `sbx ports --publish P --json` | Returns `[{action, host_ip: "127.0.0.1", host_port, sandbox_port, protocol: "tcp4"}]`; `sbx ports X --json` lists the same fields. Host ports are ephemeral (60000, 60001, ...). Publishing a port that is already published adds a second mapping, so check the list first. Nothing listening on the sandbox port: the host connection is reset (curl exit 56), no HTTP status. |
| Ports across sleep | `sbx stop` drops the mappings; on the next start sbx restores them by itself on new host ports (60000 -> 60002). Never cache a host port across a wake. Processes do not survive (a server started before the stop is gone after it). |
| Background processes from exec | `nohup python3 -m http.server 8080 &` started through `sbx exec` keeps running after that exec ends (while the sandbox stays up). |

### Tested by running on DigitalOcean (Ubuntu 24.04 droplet, Nov 12, 2026)

Droplet `s-4vcpu-8gb` in `blr1`. The unchanged code, `npm run smoke`, the fx template build, both demos and `scripts/test-remote.ts` all pass.

| Test | Result |
|---|---|
| KVM on a regular droplet | `/dev/kvm` present, VT-x exposed (`Hypervisor vendor: KVM`, `vmx` flag). Nested virtualization works on a shared-CPU droplet. |
| Install | `curl -fsSL https://get.docker.com \| REPO_ONLY=1 sh`, then `apt-get install docker-sbx`. No Docker Engine needed. Wait for first-boot `unattended-upgrades` to release the apt lock. |
| sbx v0.51.0 (apt default) | `shell` "now ships as a kit" from `docker.io/sbx/shell:latest`: Debian (Docker Hardened Images), **no Node**. The fx relay needs Node, so pin v0.50.1: `apt-get install docker-sbx=0.50.1-1~ubuntu.24.04~noble && apt-mark hold docker-sbx`. v0.50.1 gives the same Ubuntu 26.04.1 + Node 22 image as Windows. |
| sbx v0.50.1 as root | Create fails with HTTP 500: `sailor: refusing to run as root` (the guest could write privileged xattrs). Run sbx as a non-root user in the `kvm` group. v0.51.0 did run as root. |
| Sign-in | Every sbx command fails with `not signed in to Docker` until `sbx login`. On a server: `echo $PAT \| sbx login --username U --password-stdin`. No keychain on Linux, so the token is stored on disk (file permissions only). |
| Network policy | First create fails with `global network policy has not been initialized`. `sbx policy init allow-all` matches the Windows laptop default. |
| Daemon | `sbx daemon start` stays in the foreground. Run it as a systemd service (`User=sandbox`). |
| Timings | First base create 61 s (image pull). After that: create about 8 s, exec 0.3-0.8 s, exec on a stopped sandbox 4.8 s, fx template build 30.5 s, first fx turn about 10 s. |

### Weekend 2 spike: where fx streaming events can come from (fx 0.0.16, sbx v0.50.1, Nov 12, 2026)

`fx ask` has no streaming JSON mode (`fx ask --help`): `--json` prints one object at the end. Two live sources were measured during a hello.py turn:

| Source | What it gives | Verdict |
|---|---|---|
| fx plain mode (no `--json`) | stdout: raw assistant Markdown in small chunks as it is written (real text deltas). stderr: progress lines such as `Writing /home/agent/hello.py`, `Running python3 ./hello.py; echo "exit: $?"`, then the command output. No reasoning, no tool call ids, tool names only as free text. | Text only; tool events would mean parsing prose. |
| The gateway relay (`templates/fx/gateway-relay.mjs`) | Every model call is `POST /v4/ai/language-model`, answered as SSE with typed AI SDK stream parts: `stream-start`, `response-metadata`, `reasoning-start/delta/end`, `text-start/delta/end`, `tool-input-start/delta/end` (with `toolName` and call `id`), `tool-call` (full input), `finish` (usage). The next request's `prompt` holds each `tool-result` by `toolCallId`; a failed command has `output.type: "error-text"` (for `shell`, a JSON value with `exit_code`). | All 9 events can be derived. |
| Side requests | fx also sends a small request with no `tools` (title generation, a different model) and `GET /coding-agent/v1/models`. | Must be ignored when mapping events. |

Mapping from the relay: text-delta -> `response.output_text.delta`; reasoning-delta -> `response.reasoning.delta`; tool-input-start/delta -> `response.tool_call.generating`; tool-call -> `response.tool_call.started`; tool-result in the next request -> `response.tool_call.completed` or `.failed`. `response.created`, `response.completed` and `response.failed` come from the adapter (turn start, fx exit and `--json` result).

### Still open (answer by running code)

| # | Question | How to answer |
|---|---|---|
| 1 | Does a stopped local sandbox keep the agent's session files and installed packages? | **Answered Nov 12, 2026, sbx v0.50.1: yes.** A file installed as root in `/usr/local/bin` and fx's session files under `~/.fx` (10 files) survive sleep (`sbx stop` then auto-start), and the next fx turn with `--resume` remembers the earlier conversation (acceptance step 8). |
| 2 | How long do `template save` and create-from-template take locally? Is fork fast enough to be useful? | Time it. |
| 3 | Can Pi and eve run as kits? | Build a minimal kit for each. |
| 4 | Do Docker's terms allow running local `sbx` as a hosted multi-tenant service? | **Answered Nov 12, 2026: not without written permission from Docker** (read of the published text, not legal advice). `sbx` is proprietary and "subject to the Docker Subscription Service Agreement" (package `copyright` file; `sbx login` says logging in accepts it). The DSSA (Aug 26, 2026) licenses use "for Customer's internal business purposes" (2.1) and forbids to "lease, rent, loan, or otherwise transfer the Services to any third party" and to operate "products or services intended to be offered to third parties in competition with the Services" (3.3); Docker sells Cloud Sandboxes and a Sandboxes API. Personal accounts are non-commercial (3.1(a)). The docs FAQ calls local `sbx` "free to use, including for commercial and professional work", but says nothing about hosting for others. Outcome: decision 26. Sources: https://www.docker.com/legal/docker-subscription-service-agreement/ , https://docs.docker.com/ai/sandboxes/faq/ , https://github.com/docker/sbx-releases (LICENSE). |
| 5 | Do Hetzner cloud VMs expose KVM for local-mode `sbx` on Linux? (DigitalOcean: yes, see above.) | Smallest VM, `ls /dev/kvm`, `sbx diagnose`. Fallback: bare metal. |

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

`README.md`, `AGENTS.md` (for coding agents), `docs/SPEC.md` (this file), `docs/PRD.md` (product view of this spec), `docs/TESTING.md` (section 7 as a checklist; becomes an executable script). Linting config instead of a style doc. `docs/ARCHITECTURE.md` (components, request flows, adapters; started Nov 12, updated as code lands).

---

## 11. Related

- Agent37 docs: https://www.agent37.com/docs/agents-api/examples (concepts, chat, streaming, sessions, files pages read Nov 12, 2026)
- `projects/agentOS.md` - earlier isolation research (V8 isolates; not chosen because native binaries likely do not run)
- Docker Sandboxes: https://www.docker.com/blog/docker-sandboxes-vs-containers/ and https://www.docker.com/blog/comparing-sandboxing-approaches-ai-agents/
