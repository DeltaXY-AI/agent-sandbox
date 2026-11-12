// Weekend 2 checkpoint: docs/TESTING.md steps 1-5 on one template, against a running server.
// Run:  node --env-file=.env test/acceptance/checkpoint.ts            (template fx, port 3000)
// Env:  TEMPLATE (default fx), PORT (default 3000), AGENT_SANDBOX_API_KEY
// Costs a few model tokens. Prints PASS/FAIL per check; exit code 1 if any check fails.
import { request } from "node:http";
import { EVENT_NAMES } from "../../src/events/types.ts";

const PORT = Number(process.env.PORT ?? 3000);
const TEMPLATE = process.env.TEMPLATE ?? "fx";
const key = process.env.AGENT_SANDBOX_API_KEY;
if (!key) throw new Error("AGENT_SANDBOX_API_KEY not set (use --env-file=.env)");

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
}

interface Frame {
  id: number;
  event: string;
  data: any;
}

/** Connect to 127.0.0.1 and set Host: Node cannot resolve {id}.localhost on Windows. */
function call(
  method: string,
  host: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
  opts: { onFrame?: (f: Frame) => boolean | void } = {},
): Promise<{ status: number; text: string; headers: Record<string, unknown>; frames: Frame[] }> {
  const data = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const frames: Frame[] = [];
    const req = request(
      {
        host: "127.0.0.1",
        port: PORT,
        method,
        path,
        headers: {
          host: `${host}:${PORT}`,
          ...(data ? { "content-type": "application/json" } : {}),
          ...headers,
        },
      },
      (res) => {
        let text = "";
        let pending = "";
        const done = () =>
          resolve({ status: res.statusCode ?? 0, text, headers: res.headers, frames });
        res.setEncoding("utf8").on("data", (chunk: string) => {
          text += chunk;
          if (!String(res.headers["content-type"]).startsWith("text/event-stream")) return;
          pending += chunk;
          let end;
          while ((end = pending.indexOf("\n\n")) !== -1) {
            const raw = pending.slice(0, end);
            pending = pending.slice(end + 2);
            if (raw.startsWith(":")) continue; // keepalive
            const f: Partial<Frame> = {};
            for (const line of raw.split("\n")) {
              if (line.startsWith("id: ")) f.id = Number(line.slice(4));
              else if (line.startsWith("event: ")) f.event = line.slice(7);
              else if (line.startsWith("data: ")) f.data = JSON.parse(line.slice(6));
            }
            frames.push(f as Frame);
            if (opts.onFrame?.(f as Frame) === false) {
              req.destroy(); // client disconnects
              done();
              return;
            }
          }
        });
        res.on("end", done);
        res.on("error", () => done());
      },
    );
    req.on("error", (err) => (req.destroyed ? undefined : reject(err)));
    req.setTimeout(10 * 60_000, () => req.destroy(new Error(`${method} ${path} timed out`)));
    req.end(data);
  });
}

const api = (method: string, path: string, body?: unknown) =>
  call(method, "localhost", path, { authorization: `Bearer ${key}` }, body).then((r) => ({
    ...r,
    json: r.text ? JSON.parse(r.text) : null,
  }));

/** Every frame is one of the 9 events, ids run 1..n, created first, exactly one terminal last. */
function wellFormed(frames: Frame[]): string {
  if (frames.length === 0) return "no events";
  const bad = frames.find((f) => !EVENT_NAMES.includes(f.event as never));
  if (bad) return `unknown event ${bad.event}`;
  const gap = frames.findIndex((f, i) => f.id !== i + 1);
  if (gap !== -1) return `id ${frames[gap]?.id} at position ${gap + 1}`;
  if (frames[0]?.event !== "response.created") return `first event ${frames[0]?.event}`;
  const terminals = frames.filter((f) => /response\.(completed|failed)$/.test(f.event));
  if (terminals.length !== 1) return `${terminals.length} terminal events`;
  if (frames.at(-1) !== terminals[0]) return "terminal event is not last";
  return "";
}

const counts = (frames: Frame[]) =>
  Object.entries(
    frames.reduce<Record<string, number>>((m, f) => ((m[f.event] = (m[f.event] ?? 0) + 1), m), {}),
  )
    .map(([k, v]) => `${k.replace("response.", "")}=${v}`)
    .join(" ");

const started = Date.now();
const created = await api("POST", "/v1/instances", { template: TEMPLATE });
const id = created.json?.id as string;
const agentKey = created.json?.agent_key as string;
const agent = (method: string, path: string, body?: unknown, opts = {}, extra = {}) =>
  call(method, `${id}.localhost`, path, { "x-agent-key": agentKey, ...extra }, body, opts);

try {
  // Step 1: create, running, healthy.
  console.log(`== step 1: create a sandbox from ${TEMPLATE}`);
  check("POST /v1/instances -> 201", created.status === 201, `got ${created.status}`);
  let healthy = false;
  for (let t = Date.now(); !healthy && Date.now() - t < 120_000;) {
    const h = await agent("GET", "/v1/health");
    healthy = JSON.parse(h.text || "{}").healthy === true;
    if (!healthy) await new Promise((r) => setTimeout(r, 500));
  }
  check("/v1/health healthy: true", healthy, `${((Date.now() - started) / 1000).toFixed(1)}s`);

  // Step 2: streamed turn, 9-event model, ends in response.completed.
  console.log("\n== step 2: streamed turn");
  const t2 = Date.now();
  const turn = await agent("POST", "/v1/responses", {
    input: "write hello.py that prints hello, then run it",
    stream: true,
  });
  const frames = turn.frames;
  check(
    "HTTP 200 text/event-stream",
    turn.status === 200 && String(turn.headers["content-type"]).startsWith("text/event-stream"),
  );
  const shape = wellFormed(frames);
  check(
    "only the 9 events, ids 1..n, created first, one terminal last",
    shape === "",
    shape || counts(frames),
  );
  check(
    "ends in response.completed",
    frames.at(-1)?.event === "response.completed",
    `${((Date.now() - t2) / 1000).toFixed(1)}s`,
  );
  check(
    "streamed text deltas",
    frames.some((f) => f.event === "response.output_text.delta"),
  );
  check(
    "tool calls started and completed",
    frames.some((f) => f.event === "response.tool_call.started") &&
      frames.some((f) => f.event === "response.tool_call.completed"),
  );
  const sessionId = frames[0]?.data?.session_id as string;

  // Step 3: second streamed turn, disconnect halfway, reattach with Last-Event-ID.
  console.log("\n== step 3: disconnect halfway, reattach");
  const DISCONNECT_AFTER = 6;
  let firstCount = 0;
  const first = await agent(
    "POST",
    "/v1/responses",
    {
      input: "Explain in about 120 words what hello.py does and how Python runs it.",
      session_id: sessionId,
      stream: true,
    },
    { onFrame: () => (firstCount += 1) < DISCONNECT_AFTER },
  );
  const responseId = first.frames[0]?.data?.id as string;
  const lastSeen = first.frames.at(-1)?.id ?? 0;
  const endedEarly = !first.frames.some(
    (f) => f.event === "response.completed" || f.event === "response.failed",
  );
  check(
    `disconnected after ${first.frames.length} events, before the end`,
    endedEarly,
    `last id ${lastSeen}`,
  );
  const rest = await agent(
    "GET",
    `/v1/responses/${responseId}/stream`,
    undefined,
    {},
    { "last-event-id": String(lastSeen) },
  );
  const joined = [...first.frames, ...rest.frames];
  const joinedShape = wellFormed(joined);
  check(
    "reattach resumes after Last-Event-ID: no gap, no duplicate",
    joinedShape === "",
    joinedShape || `${first.frames.length} + ${rest.frames.length} events`,
  );
  check(
    "reattached stream ends in response.completed",
    rest.frames.at(-1)?.event === "response.completed",
  );
  const replay = await agent("GET", `/v1/responses/${responseId}/stream`);
  check(
    "full replay without Last-Event-ID equals the joined stream",
    JSON.stringify(replay.frames) === JSON.stringify(joined),
    `${replay.frames.length} events`,
  );
  const missing = await agent("GET", "/v1/responses/resp_doesnotexist/stream");
  check(
    "unknown response -> 404 response_not_found",
    missing.status === 404 && missing.text.includes("response_not_found"),
  );

  // Step 4: read hello.py through the files API.
  console.log("\n== step 4: files API");
  const list = await agent("GET", "/v1/files");
  const listing = JSON.parse(list.text || "{}");
  const entry = listing.entries?.find((e: { name: string }) => e.name === "hello.py");
  check(
    "GET /v1/files lists hello.py in /home/agent",
    list.status === 200 && listing.path === "/home/agent" && entry?.type === "file",
    entry ? `size ${entry.size}` : list.text.slice(0, 120),
  );
  const content = await agent("GET", "/v1/files/content?path=hello.py");
  check(
    "GET /v1/files/content returns the file",
    content.status === 200 && /print\(\s*["']hello["']\s*\)/i.test(content.text),
    JSON.stringify(content.text.slice(0, 60)),
  );
  check(
    "content length matches the listing",
    Number(content.headers["content-length"]) === entry?.size,
  );
  const nofile = await agent("GET", "/v1/files/content?path=/home/agent/nope.txt");
  check(
    "missing file -> 404 file_not_found",
    nofile.status === 404 && nofile.text.includes("file_not_found"),
  );
  const notdir = await agent("GET", "/v1/files?path=/home/agent/hello.py");
  check(
    "listing a file -> 400 not_a_directory",
    notdir.status === 400 && notdir.text.includes("not_a_directory"),
  );

  // Step 5: ls through exec.
  console.log("\n== step 5: exec");
  const ls = await api("POST", `/v1/instances/${id}/exec`, { command: "ls /home/agent" });
  check(
    "ls /home/agent lists hello.py, exit 0",
    ls.json?.exit_code === 0 && /^hello\.py$/m.test(ls.json?.stdout ?? ""),
    JSON.stringify(ls.json?.stdout),
  );
} finally {
  const del = await api("DELETE", `/v1/instances/${id}`);
  console.log(`\ncleanup: DELETE ${id} -> ${del.status}`);
}

console.log(
  failures === 0
    ? `\nCHECKPOINT PASSED on ${TEMPLATE} (${((Date.now() - started) / 1000).toFixed(0)}s)`
    : `\n${failures} CHECK(S) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
