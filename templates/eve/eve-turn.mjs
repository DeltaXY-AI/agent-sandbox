// Runs one eve turn inside the sandbox and reports it as JSON lines on stdout.
// Run (Node 24): node eve-turn.mjs <message> [eve-session-id]
//
// Starts the eve server (`eve start`, prebuilt in /home/agent/eve-agent) if it is not
// running, e.g. after the sandbox woke from sleep. Sends the message to a new eve session
// or to an existing one, then follows the session's NDJSON stream until the turn settles.
//
// Output lines (each one JSON object):
//   {"t":"session","id":"<eve session id>"}          first
//   {"t":"line","line":{...}}                         every stream line of this turn, as is
//   {"t":"end","outcome":"completed"|"failed"|...}   last (or {"t":"error","message"})
import { spawn } from "node:child_process";
import { openSync } from "node:fs";

const PROJECT = process.env.EVE_PROJECT ?? "/home/agent/eve-agent";
const PORT = Number(process.env.EVE_PORT ?? 7700);
const BASE = `http://127.0.0.1:${PORT}/eve/v1`;
const TURN_TIMEOUT_MS = 14 * 60_000;

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function healthy() {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Start `eve start` in the background if nothing answers, and wait until it does. */
async function ensureServer() {
  if (await healthy()) return;
  const log = openSync("/tmp/eve-server.log", "a");
  const child = spawn("npx", ["eve", "start", "--host", "127.0.0.1", "--port", String(PORT)], {
    cwd: PROJECT,
    env: { ...process.env, EVE_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", log, log],
    detached: true,
  });
  child.unref();
  for (let i = 0; i < 120; i++) {
    if (await healthy()) return;
    await sleep(250);
  }
  throw new Error("eve server did not become healthy in 30 s (see /tmp/eve-server.log)");
}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

/**
 * Index the next stream line will have, so this turn reads only its own lines.
 * `x-eve-stream-tail-index` is the position of the last recorded line (-1 when empty).
 */
async function nextIndex(sessionId) {
  const res = await fetch(`${BASE}/session/${sessionId}/stream?includeTailIndex=1&follow=false`);
  const header = res.headers.get("x-eve-stream-tail-index");
  await res.body?.cancel();
  if (header === null) throw new Error(`stream -> ${res.status}: no x-eve-stream-tail-index`);
  return Number(header) + 1;
}

const [message, existing] = process.argv.slice(2);
try {
  if (!message) throw new Error("usage: eve-turn.mjs <message> [eve-session-id]");
  await ensureServer();
  let sessionId = existing;
  let startIndex = 0;
  if (sessionId) {
    startIndex = await nextIndex(sessionId);
    await post(`/session/${sessionId}`, { message });
  } else {
    sessionId = (await post("/session", { message })).sessionId;
  }
  out({ t: "session", id: sessionId });

  const deadline = Date.now() + TURN_TIMEOUT_MS;
  let index = startIndex;
  let outcome;
  // Follow the stream; reconnect from our cursor when the server ends a lease.
  while (!outcome && Date.now() < deadline) {
    const res = await fetch(`${BASE}/session/${sessionId}/stream?startIndex=${index}`);
    if (!res.ok || !res.body) throw new Error(`stream -> ${res.status}`);
    const decoder = new TextDecoder();
    let pending = "";
    for await (const chunk of res.body) {
      pending += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = pending.indexOf("\n")) !== -1) {
        const raw = pending.slice(0, nl).trim();
        pending = pending.slice(nl + 1);
        if (!raw) continue;
        const line = JSON.parse(raw);
        if (line.$eve) continue; // heartbeat, lease end, stream end: transport only
        index++;
        out({ t: "line", line });
        for (const fact of line.facts ?? []) {
          if (fact.type === "turn.settled") outcome = fact.data?.outcome ?? "completed";
          if (fact.type === "turn.paused") outcome = "paused";
        }
      }
      if (outcome) break;
    }
    if (outcome) await res.body.cancel().catch(() => undefined);
  }
  out({ t: "end", outcome: outcome ?? "timeout" });
} catch (err) {
  out({ t: "error", message: err instanceof Error ? err.message : String(err) });
}
process.exit(0);
