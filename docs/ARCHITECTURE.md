# ARCHITECTURE

How the pieces fit. `docs/SPEC.md` holds the decisions; this file shows the shape. Updated as code lands.

## Components

```
                    Client (curl / TS SDK / app)
             |                                      |
   api.<domain>  (localhost:3000)            {id}.<domain>  ({id}.localhost)
   Authorization: Bearer <key>               X-Agent-Key: <key>
             |                                      |
             v                                      v
+-------------------------------------------------------------------------+
| CONTROL PLANE - one Node process on the host (Hono HTTP server inside)  |
|                                                                         |
|  Auth (API keys)                                                        |
|        |                                    |                           |
|        v                                    v                           |
|  Sandbox API                         Router  (Host header -> sandbox id)|
|  /v1/instances, /exec,                 | sleeping: wake, hold request   |
|  /stop, /start, /logs, /fork           |   until /v1/health is healthy  |
|        |                               |-- /v1/*      -> Agent API      |
|        |                               |-- other path -> port proxy ----+--> published
|        |                               v                                |    loopback port
|        |                        Agent API                               |
|        |                        /v1/responses, /sessions, /files        |
|        |                               |                                |
|        |                        HarnessAdapter (fx | pi | eve | ...)    |
|        |                               | harness output -> AgentEvent   |
|        |                               v                                |
|        |                        Event bus: 9 SSE events + replay buffer |
|        v                               |                                |
|  Lifecycle manager  <------------------+  (activity resets idle timer)  |
|  state machine + idle timer                                             |
|        |                                                                |
|  Meter (running min, sleeping min, tokens)    State (in memory for now) |
+--------+----------------------------------------------------------------+
         |  HostProvider - the only code that knows where it runs
         v
   local-windows  |  hetzner  |  digitalocean
         |  sbx CLI: create / exec / stop / cp / ports / template save / ls --json / secret
         v
+-------------------------------------------+
| microVM per sandbox (Ubuntu)              |
|   template: base | fx | pi | eve | ...    |
|   harness CLI, run once per turn via exec |
|   /home/agent (disk survives stop)        |
|   user server on :8080 (public port)      |
+-------------------------------------------+
         |  outbound HTTPS through the sbx proxy
         v
   Vercel AI Gateway  (proxy swaps the placeholder key for the real one)
```

The control plane never opens a network connection into a VM except to a published port. Everything else goes through `sbx exec`, `sbx cp` and `sbx ports`.

## Flows

**Create.** Sandbox API -> Lifecycle (`provisioning`) -> `HostProvider.createSandbox` -> `sbx create` from the template -> `running`.

**Turn (weekend 1, non-streaming).** `POST /v1/responses` -> Agent API (409 if the session has a turn running) -> HarnessAdapter builds the harness command -> `sbx exec <id> fx ask --json ...` -> adapter maps the harness result to the response shape and our session id to the harness session id.

**Wake (later).** Request for a `sleeping` sandbox -> Router holds it -> Lifecycle -> `HostProvider.start` -> health passes -> request released.

## The two adapters

| Interface | Knows about | One per |
|---|---|---|
| `HostProvider` | Where sandboxes run and how to drive `sbx` there. | Host (local-windows, hetzner, digitalocean). |
| `HarnessAdapter` | One agent CLI: its command line, output format, session ids, errors. Translates to our response shape and the 9 events. | Harness (fx, pi, eve). |

Nothing outside these two may know which host or which harness is in use (AGENTS.md rule 4).

## Secrets

The model key lives on the host (`.env`, never committed). At sandbox creation the control plane registers it with `sbx secret set-custom --sandbox <id>`. The VM only sees a placeholder in `AI_GATEWAY_API_KEY`; the `sbx` proxy substitutes the real key on requests to the Gateway host.

## Open

- Where session history lives for fork (control plane vs harness files in the VM).
- Persistent store once state must survive a control-plane restart.
