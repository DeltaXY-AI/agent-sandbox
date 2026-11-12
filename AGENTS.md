# AGENTS.md

Instructions for coding agents working in this repository.

## What this is

A TypeScript platform that runs AI agents in Docker Sandboxes microVMs behind one HTTP API. Read `docs/SPEC.md` before changing anything. `docs/TESTING.md` is the definition of done.

## Status

Weekend 1 done (Nov 12, 2026): Sandbox API (`base` template) and non-streaming `/v1/responses` on the `fx` template, routed by `{id}.localhost`. Not yet built: streaming, files API, public ports, fork, sleep/wake timer, metering.

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
| `node --env-file=.env scripts/demo-sandbox-api.ts` | Sandbox API demo (server must be running). |
| `node --env-file=.env scripts/demo-agent.ts` | Agent demo on fx: first message, follow-up, hello.py (server must be running; costs a few model tokens). |

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
