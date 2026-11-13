# AGENTS.md

Instructions for coding agents working in this repository.

## What this is

A TypeScript platform that runs AI agents in Docker Sandboxes microVMs behind one HTTP API. Read `docs/SPEC.md` before changing anything. `docs/TESTING.md` is the definition of done.

## Status

Weekend 1 done (Nov 12, 2026): Sandbox API (`base` template) and non-streaming `/v1/responses` on the `fx` template, routed by `{id}.localhost`.

Weekend 2 checkpoint passed on fx (Nov 12, 2026): streamed turns with the 9 SSE events, reattach with `Last-Event-ID`, files API (`GET /v1/files`, `GET /v1/files/content`). `npm run acceptance` runs TESTING.md steps 1-5. Not yet built: file writes (PUT, DELETE, PATCH, dir, archive), cancel, WebSocket proxying, wallet and prices, user-supplied eve projects. Claude Code left Phase 1 (SPEC decision 35).

Sleep and wake (Nov 12, 2026): `POST /v1/instances/{id}/sleep`, idle timer (`idle_timeout_seconds`, default 900), any request wakes a sleeping instance; stopped stays off until `/start`. Acceptance step 8 passes on fx.

Public ports (Nov 12, 2026): preview URLs `{id}-{port}.localhost` (API key, `X-Agent-Key` or signed URL), `public_ports` (no credential), `POST /v1/instances/{id}/signed-url`. Acceptance step 6 passes on fx. WebSockets not yet proxied.

Workspaces and keys (Nov 12, 2026): SQLite store (`data/agent-sandbox.db`), admin API `/v1/admin/workspaces` (admin key), `sk_live_` keys scoped to a workspace, `AGENT_SANDBOX_API_KEY` = default workspace. Every sandbox is denied the host loopback. Acceptance step 9 passes on fx.

Meter (Nov 12, 2026): `GET /v1/usage` (awake and sleeping minutes, turns and tokens per instance, day and model; no prices yet) and `GET /v1/instances/{id}/events`, from state changes and turn usage kept in SQLite. Acceptance step 10 passes on fx.

Pi (Nov 12, 2026): template `pi` (Pi 1.5.2, `pi --mode json` through the AI Gateway). `TEMPLATE=pi npm run acceptance` passes steps 1-6 and 8-10, as fx does.

eve (Nov 12, 2026): template `eve` (eve 1.0.0-rc.10 on Node 24, default project in `/home/agent/eve-agent`, `templates/eve/eve-turn.mjs`). `TEMPLATE=eve npm run acceptance` passes steps 1-6 and 8-10, as fx and Pi do.

Fork (Nov 13, 2026): `POST /v1/instances/{id}/fork` (sbx: stop, template save, create from it, remove the image; sessions copied). Acceptance step 7 passes on fx, Pi and eve, so `npm run acceptance` runs steps 1-10.

Cross-check (Nov 13, 2026): `npm run cross-check` (TESTING.md step 11) passes on fx, Pi and eve: identical event names and field shapes (`src/events/schema.ts`), and a working `hello.py` on all three. Claude Code left Phase 1 (SPEC decision 35), so the Phase 1 acceptance (3 x 10 checks and the cross-check) passes.

## Rules

1. Run the code and verify it. Do not report a step as working until you ran it and saw the output.
2. Use only what the spec decides. If the spec does not cover something, ask; do not invent scope.
3. Every harness emits exactly the 9 SSE events in `docs/SPEC.md` section 3. Never add harness-specific events to the public API.
4. Cloud-specific code goes only in a `HostProvider`. Harness-specific code goes only in a `HarnessAdapter`. Nothing else may know which cloud or harness is in use.
5. Drive `sbx` through its CLI with JSON output where it exists (`sbx ls --json`). Check exit codes: 125 means `sbx` could not run the command.
6. No emojis in code, logs or docs. The project is developed on Windows.
7. Never put API keys or secrets in the repo. Use environment variables.
8. When an `sbx` behaviour surprises you, write it down in `docs/SPEC.md` section 8 with the `sbx` version.

## Commands

Node 24 runs the `.ts` files directly; there is no build step. Secrets go in `.env` (git-ignored): `AGENT_SANDBOX_API_KEY` (default workspace), `AGENT_SANDBOX_ADMIN_KEY` (admin API; optional), `AI_GATEWAY_API_KEY`. State lives in `data/agent-sandbox.db` (git-ignored; `DATABASE_PATH`).

| Command | What it does |
|---|---|
| `npm install` | Install dependencies. |
| `npm run check` | Typecheck (`tsc`), lint, unit tests. Run before reporting work as done. |
| `npm start` | Control plane on `http://localhost:3000`. |
| `node scripts/build-fx-template.ts` | Build the `fx` sbx template (needed once, and after changing `templates/fx/`). |
| `node scripts/build-pi-template.ts` | Build the `pi` sbx template (needed once, and after changing `PI_VERSION`). |
| `node scripts/build-eve-template.ts` | Build the `eve` sbx template: Node 24, the default eve project (npm install + eve build), the turn shim (needed once, and after changing `templates/eve/` or `EVE_VERSION`). |
| `npm run smoke` | Drive `sbx` from Node: create, exec, stop, auto-start, delete. |
| `npm run acceptance` | TESTING.md steps 1-10 against a running server: create, streamed turn, disconnect and reattach, files API, exec, public ports, fork, sleep and wake, workspaces and isolation, usage. Step 9 needs `AGENT_SANDBOX_ADMIN_KEY`. `TEMPLATE` (default fx), `PORT`. Costs a few model tokens. |
| `npm run cross-check` | TESTING.md step 11 against a running server: the same prompt on fx, Pi and eve at once; checks every event against the spec's schema, that the field shapes are identical, and that `hello.py` runs on all three. `TEMPLATES` (default `fx,pi,eve`), `PORT`. Costs a few model tokens. |
| `node --env-file=.env scripts/demo-sandbox-api.ts` | Sandbox API demo (server must be running). |
| `node --env-file=.env scripts/demo-agent.ts` | Agent demo on fx: first message, follow-up, hello.py (server must be running; costs a few model tokens). |
| `npm run demo:workspaces` | Keys and workspaces as a six-act story: admin creates two workspaces, isolation by key and by network, key revocation, what the database keeps (server must be running; `-- --pause` waits between acts; no model tokens). |
| `npm run deploy:do` | Immutable deploy to DigitalOcean: new droplet from `deploy/cloud-init.yaml`, push secrets over SSH, run checks, build fx, run `test-remote`, move the reserved IP, delete old droplets. On failure the new droplet is deleted. Needs a clean git tree and `DOCKER_USERNAME`, `DOCKER_PAT` in `.env`. |
| `npm run test:remote` | Test a deployed server through an SSH tunnel (set `REMOTE_HOST`; `-- --skip-agent` skips model tokens). |
| `npm run destroy:do` | List droplets tagged `agent-sandbox` and their reserved IP; `-- --yes` deletes them. |

In Git Bash, set `MSYS_NO_PATHCONV=1` before passing Linux paths to `sbx`.

## Layout (planned)

```
src/
  api/         HTTP server: sandbox API and agent API
  router/      {id}.<domain> routing and wake-on-request
  events/      the 9-event model, SSE writer, replay buffer
  hosts/       HostProvider implementations (local-windows, hetzner, digitalocean)
  harnesses/   HarnessAdapter implementations (fx, pi, eve, ...)
  meter/       usage metering
templates/     what goes into the fx and eve sbx templates
test/acceptance/  the docs/TESTING.md script
```

## First tasks (weekend 1)

1. Drive `sbx` from Node: create a sandbox, run `ls` through exec, list with `--json`, remove it.
2. ~~Run Claude Code non-interactively~~ Done with fx instead (SPEC decisions 20 and 35).
3. Answer the "Still open" questions in `docs/SPEC.md` section 8 by running code. Record the answers there.
