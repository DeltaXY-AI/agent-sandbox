// Acceptance: docs/TESTING.md steps 1-6 and 8-10 on one template (checkpoint, public ports,
// sleep and wake, workspaces and isolation, usage), against a running server.
// Run:  node --env-file=.env test/acceptance/checkpoint.ts            (template fx, port 3000)
// Env:  TEMPLATE (default fx), PORT (default 3000), AGENT_SANDBOX_API_KEY, AGENT_SANDBOX_ADMIN_KEY
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

  // Step 6: the agent starts a web server on 8080; reach it through the router.
  console.log("\n== step 6: public ports");
  const pub = await api("POST", `/v1/instances/${id}/public-ports`, {
    port: 8080,
    prefix: "web",
  });
  check(
    "POST /public-ports -> 201 with a URL",
    pub.status === 201 && pub.json?.url?.includes(`web-${id}.localhost`),
    pub.json?.url,
  );
  const serve = await agent("POST", "/v1/responses", {
    input:
      "Start a web server on port 8080 that serves /home/agent and keeps running after you finish: " +
      "run `cd /home/agent && nohup python3 -m http.server 8080 > /tmp/http.log 2>&1 &`, " +
      "then check it with curl and reply with one short sentence.",
    session_id: sessionId,
  });
  check(
    "agent turn to start the server completes",
    serve.status === 200 && JSON.parse(serve.text || "{}").status === "completed",
  );
  const previewHost = `${id}-8080.localhost`;
  let page = await call("GET", previewHost, "/hello.py", { authorization: `Bearer ${key}` });
  for (let i = 0; i < 10 && page.status !== 200; i++) {
    await new Promise((r) => setTimeout(r, 1000)); // the server may still be starting
    page = await call("GET", previewHost, "/hello.py", { authorization: `Bearer ${key}` });
  }
  check(
    `preview URL http://${previewHost} with the API key serves hello.py`,
    page.status === 200 && /hello/.test(page.text),
    `${page.status} ${JSON.stringify(page.text.slice(0, 40))}`,
  );
  const noKey = await call("GET", previewHost, "/", {});
  check("preview URL without a credential -> 401", noKey.status === 401, `got ${noKey.status}`);
  const signed = await api("POST", `/v1/instances/${id}/signed-url`, { port: 8080 });
  const signedUrl = new URL(signed.json?.url ?? "http://x/");
  const viaSigned = await call("GET", previewHost, `/hello.py${signedUrl.search}`, {});
  check(
    "signed URL opens the preview without a key and sets a cookie",
    viaSigned.status === 200 && String(viaSigned.headers["set-cookie"]).includes("as_token="),
    `got ${viaSigned.status}`,
  );
  const publicPage = await call("GET", `web-${id}.localhost`, "/hello.py", {});
  check(
    "public port URL works with no credential",
    publicPage.status === 200 && /hello/.test(publicPage.text),
    `got ${publicPage.status}`,
  );
  const nothing = await call("GET", `${id}-8099.localhost`, "/", {
    authorization: `Bearer ${key}`,
  });
  check("a port nothing listens on -> 502", nothing.status === 502, `got ${nothing.status}`);

  // Step 9: a second workspace cannot read the first one's sandbox, by key or by network.
  console.log("\n== step 9: workspaces and isolation");
  const adminKey = process.env.AGENT_SANDBOX_ADMIN_KEY;
  if (!adminKey) {
    check("AGENT_SANDBOX_ADMIN_KEY is set (needed to create a second workspace)", false);
  } else {
    const wsB = await call(
      "POST",
      "localhost",
      "/v1/admin/workspaces",
      { authorization: `Bearer ${adminKey}` },
      { name: `acceptance-b-${Date.now()}` },
    );
    const keyB = JSON.parse(wsB.text || "{}").api_key?.key as string;
    check("admin API creates workspace B with its own key", wsB.status === 201 && Boolean(keyB));
    const asB = { authorization: `Bearer ${keyB}` };
    const readA = await call("POST", "localhost", `/v1/instances/${id}/exec`, asB, {
      command: "cat /home/agent/hello.py",
    });
    check("B's key cannot exec in A's sandbox -> 404", readA.status === 404, `got ${readA.status}`);
    const listB = JSON.parse((await call("GET", "localhost", "/v1/instances", asB)).text || "{}");
    check(
      "B's key lists none of A's instances",
      Array.isArray(listB.data) && listB.data.length === 0,
    );
    const previewB = await call("GET", previewHost, "/hello.py", asB);
    check("B's key on A's preview URL -> 404", previewB.status === 404, `got ${previewB.status}`);

    // Network: from B's own sandbox, try A directly and the host's loopback (where every
    // published port and the control plane listen).
    const ipA = (
      await api("POST", `/v1/instances/${id}/exec`, { command: "hostname -I | cut -d' ' -f1" })
    ).json?.stdout?.trim();
    const createdB = await call("POST", "localhost", "/v1/instances", asB, { template: "base" });
    const idB = JSON.parse(createdB.text || "{}").id as string;
    try {
      for (let t = Date.now(); Date.now() - t < 120_000;) {
        const s = JSON.parse((await call("GET", "localhost", `/v1/instances/${idB}`, asB)).text);
        if (s.status === "running") break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      const probe = await call("POST", "localhost", `/v1/instances/${idB}/exec`, asB, {
        command:
          `for u in http://${ipA}:8080/hello.py http://host.docker.internal:${PORT}/v1/instances ` +
          `http://localhost:${PORT}/v1/instances; do ` +
          `printf '%s ' "$u"; curl -s -m 5 -o /dev/null -w '%{http_code}\\n' "$u"; done`,
      });
      const lines: string[] = (JSON.parse(probe.text || "{}").stdout ?? "").trim().split("\n");
      const reached = lines.filter((l) => / (200|401|404)$/.test(l));
      check(
        "B's sandbox cannot reach A's sandbox or the host loopback",
        lines.length === 3 && reached.length === 0,
        lines.map((l) => l.replace(/^http:\/\//, "")).join("; "),
      );
    } finally {
      if (idB) await call("DELETE", "localhost", `/v1/instances/${idB}`, asB);
    }
  }

  // Step 8: sleep, send a message, it wakes and the session continues.
  // Also answers SPEC open question 1: do installed files and the harness's own
  // session files survive sleep?
  console.log("\n== step 8: sleep and wake");
  const STATE =
    "ls /usr/local/bin/acceptance-marker; find ~/.fx ~/.pi ~/eve-agent/.eve/.workflow-data -type f 2>/dev/null | wc -l | tr -d ' '";
  await api("POST", `/v1/instances/${id}/exec`, {
    command: "echo installed > /usr/local/bin/acceptance-marker",
    user: "root",
  });
  const before = await api("POST", `/v1/instances/${id}/exec`, { command: STATE });
  const slept = await api("POST", `/v1/instances/${id}/sleep`);
  check("POST /sleep -> sleeping", slept.json?.status === "sleeping", slept.json?.status);
  const t8 = Date.now();
  const followUp = await agent("POST", "/v1/responses", {
    input:
      "Without using any tools: what is the name of the Python file you created earlier in this conversation? Answer with just the file name.",
    session_id: sessionId,
  });
  const reply = JSON.parse(followUp.text || "{}");
  check(
    "a turn on the sleeping instance wakes it and completes",
    followUp.status === 200 && reply.status === "completed",
    `${((Date.now() - t8) / 1000).toFixed(1)}s, ${followUp.status} ${reply.status}`,
  );
  check(
    "the reply remembers the earlier turn (hello.py)",
    /hello\.py/i.test(reply.output_text ?? ""),
    JSON.stringify(reply.output_text?.slice(0, 80)),
  );
  const awake = await api("GET", `/v1/instances/${id}`);
  check("instance is running again", awake.json?.status === "running", awake.json?.status);
  const after = await api("POST", `/v1/instances/${id}/exec`, { command: STATE });
  const [, beforeFx] = (before.json?.stdout ?? "").trim().split("\n");
  const [marker, afterFx] = (after.json?.stdout ?? "").trim().split("\n");
  check(
    "installed file and harness session files survived sleep",
    marker === "/usr/local/bin/acceptance-marker" &&
      Number(afterFx) >= Number(beforeFx) &&
      Number(beforeFx) > 0,
    `marker ${marker ? "kept" : "lost"}, harness files ${beforeFx} -> ${afterFx}`,
  );

  // Step 10: /v1/usage shows running minutes, sleeping minutes and tokens for the sandbox.
  // The tokens must equal what the four turns above reported, so nothing is lost or doubled.
  console.log("\n== step 10: usage");
  const reported = [
    frames.at(-1)?.data?.usage, // step 2 (streamed)
    rest.frames.at(-1)?.data?.usage, // step 3 (streamed, reattached)
    JSON.parse(serve.text || "{}").usage, // step 6
    reply.usage, // step 8
  ];
  const sum = (k: "input_tokens" | "output_tokens") =>
    reported.reduce((n, u) => n + (u?.[k] ?? 0), 0);
  const today = new Date().toISOString().slice(0, 10);
  const usage = await api("GET", `/v1/usage?from=${today}&to=${today}`);
  const mine = usage.json?.instances?.find((i: { id: string }) => i.id === id);
  check("GET /v1/usage -> 200 with this sandbox", usage.status === 200 && Boolean(mine));
  check("running (awake) minutes > 0", mine?.awake_minutes > 0, `${mine?.awake_minutes} min`);
  check(
    "sleeping minutes > 0 (step 8 slept it)",
    mine?.sleeping_minutes > 0,
    `${mine?.sleeping_minutes} min`,
  );
  check(
    "tokens equal the sum of the 4 turns' reported usage",
    mine?.turns === 4 &&
      mine?.input_tokens === sum("input_tokens") &&
      mine?.output_tokens === sum("output_tokens"),
    `turns ${mine?.turns}, in ${mine?.input_tokens}/${sum("input_tokens")}, out ${mine?.output_tokens}/${sum("output_tokens")}`,
  );
  const events = await api("GET", `/v1/instances/${id}/events?from=${today}&to=${today}`);
  const types: string[] = (events.json?.events ?? []).map((e: { type: string }) => e.type);
  check(
    "GET /v1/instances/{id}/events shows it slept and woke",
    types.includes("instance.sleeping") && types.includes("instance.waking"),
    types.join(" > "),
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
