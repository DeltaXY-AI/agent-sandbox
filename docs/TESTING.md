# Acceptance script - Phase 1

Phase 1 is done only when every check below passes. This file becomes an executable script in `test/acceptance/`.

## Per-template checks

Run steps 1-10 on each template. Mark each cell when it passes.

| # | Step | Expected | Claude Code | Pi | eve |
|---|---|---|---|---|---|
| 1 | Create a sandbox from the template. | Status reaches `running`; `/v1/health` returns `healthy: true`. | [ ] | [ ] | [ ] |
| 2 | Streamed turn: "write hello.py that prints hello, then run it". | The 9-event model only, ending in `response.completed`. | [ ] | [ ] | [ ] |
| 3 | Second streamed turn. Disconnect halfway. Reattach via `/v1/responses/{id}/stream`. | Remaining events arrive with no gap and no duplicate. | [ ] | [ ] | [ ] |
| 4 | Read `hello.py` through the files API. | Content matches what the agent wrote. | [ ] | [ ] | [ ] |
| 5 | Run `ls /home/agent` through exec. | Output lists `hello.py`; exit status 0. | [ ] | [ ] | [ ] |
| 6 | Ask the agent to start a web server on port 8080. Open the preview URL `http://{id}-8080.localhost` (key or signed URL) and a public port URL. | HTTP response from the sandbox's server. | [ ] | [ ] | [ ] |
| 7 | Fork the sandbox. | The fork has `hello.py` and the full session history. | [ ] | [ ] | [ ] |
| 8 | Put the original to sleep. Send a message. | It wakes; the reply shows the earlier history. | [ ] | [ ] | [ ] |
| 9 | Use a key from a second workspace to read the first workspace's files. From inside the second sandbox, try to reach the first over the network. | 401 or 404 for the key; network refused. | [ ] | [ ] | [ ] |
| 10 | Call `/v1/usage`. | Running minutes, sleeping minutes and tokens for the sandbox. | [ ] | [ ] | [ ] |

## Cross-check

| # | Step | Expected | Pass |
|---|---|---|---|
| 11 | Send the same prompt to all three templates. | Identical event names and field shapes; all three produce a working `hello.py`. | [ ] |

## Checkpoint (end of weekend 2)

Steps 1-5 pass on at least one template. If not, decide: continue, switch to Docker + gVisor, or stop.

**Passed on fx, Nov 12, 2026** (SPEC decision 24): `npm run acceptance`, 18 of 18 checks, sbx v0.50.1, fx 0.0.16. Local Windows host: 51 s. DigitalOcean droplet (Ubuntu 24.04, s-4vcpu-8gb, blr1, deployed with `npm run deploy:do`, run through an SSH tunnel): 25 s.

**Step 8 passes on fx, Nov 12, 2026:** sleep, then a follow-up turn wakes the sandbox (6.0 s including the turn) and the reply names `hello.py` from the earlier turn. Local Windows host, sbx v0.50.1. Part of `npm run acceptance` (23 checks).

**Step 6 passes on fx, Nov 12, 2026:** the agent starts `python3 -m http.server 8080`; the preview URL serves `hello.py` with the API key and with a signed URL (no key, cookie set), 401 without a credential, the public port URL serves it with no credential, and a port nothing listens on gives 502. `npm run acceptance`: 30 checks.

**Step 9 passes on fx, Nov 12, 2026:** workspace B (made with the admin API) gets 404 for exec, listing and the preview URL of workspace A's sandbox. From B's sandbox, A's IP is unreachable, `host.docker.internal:<control plane port>` answers 403 (blocked by the per-sandbox deny rule) and `localhost` is unreachable. `npm run acceptance`: 35 checks.

**Step 10 passes on fx, Nov 12, 2026:** `/v1/usage` shows the sandbox with awake minutes (1.31) and sleeping minutes (0.06, from step 8), and its tokens equal the sum of the usage its 4 turns reported (75968 in, 878 out). `/v1/instances/{id}/events` shows provisioning > running > stopping > sleeping > waking > running. Usage is unchanged after the sandbox is deleted and the server restarts. `npm run acceptance`: 40 checks.
