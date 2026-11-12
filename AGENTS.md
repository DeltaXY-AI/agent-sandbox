# AGENTS.md

Instructions for coding agents working in this repository.

## What this is

A TypeScript platform that runs AI agents in Docker Sandboxes microVMs behind one HTTP API. Read `docs/SPEC.md` before changing anything. `docs/TESTING.md` is the definition of done.

## Status

Weekend 1 done (Nov 12, 2026): Sandbox API (`base` template) and non-streaming `/v1/responses` on the `fx` template, routed by `{id}.localhost`.

Weekend 2 checkpoint passed on fx (Nov 12, 2026): streamed turns with the 9 SSE events, reattach with `Last-Event-ID`, files API (`GET /v1/files`, `GET /v1/files/content`). `npm run acceptance` runs TESTING.md steps 1-5. Not yet built: file writes (PUT, DELETE, PATCH, dir, archive), cancel, public ports, fork (after the engine switch), keys and workspaces, metering, Pi/eve/Claude Code adapters.

Sleep and wake (Nov 12, 2026): `POST /v1/instances/{id}/sleep`, idle timer (`idle_timeout_seconds`, default 900), any request wakes a sleeping instance; stopped stays off until `/start`. Acceptance step 8 passes on fx.

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

Node 24 runs the `.ts` files directly; there is no build step. Secrets go in `.env` (git-ignored): `AGENT_SANDBOX_API_KEY`, `AI_GATEWAY_API_KEY`.

| Command | What it does |
|---|---|
| `npm install` | Install dependencies. |
| `npm run check` | Typecheck (`tsc`), lint, unit tests. Run before reporting work as done. |
| `npm start` | Control plane on `http://localhost:3000`. |
| `node scripts/build-fx-template.ts` | Build the `fx` sbx template (needed once, and after changing `templates/fx/`). |
| `npm run smoke` | Drive `sbx` from Node: create, exec, stop, auto-start, delete. |
| `npm run acceptance` | TESTING.md steps 1-5 and 8 against a running server: create, streamed turn, disconnect and reattach, files API, exec, sleep and wake. `TEMPLATE` (default fx), `PORT`. Costs a few model tokens. |
| `node --env-file=.env scripts/demo-sandbox-api.ts` | Sandbox API demo (server must be running). |
| `node --env-file=.env scripts/demo-agent.ts` | Agent demo on fx: first message, follow-up, hello.py (server must be running; costs a few model tokens). |
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
  harnesses/   HarnessAdapter implementations (claude-code, pi, eve, ...)
  meter/       usage metering
templates/     sbx kits for pi and eve
test/acceptance/  the docs/TESTING.md script
```

## First tasks (weekend 1)

1. Drive `sbx` from Node: create a sandbox, run `ls` through exec, list with `--json`, remove it.
2. Run Claude Code non-interactively in a sandbox through exec with stream-json output, and print the raw events.
3. Answer the "Still open" questions in `docs/SPEC.md` section 8 by running code. Record the answers there.
