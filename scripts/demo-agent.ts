// Demo: Agent37-style examples on fx, against a running server (npm start).
//   Example 1: first agent message (create, health, one turn, follow-up in the same session)
//   Example 2: the agent writes hello.py and runs it; we check it through exec
// Run: node --env-file=.env scripts/demo-agent.ts
import { request } from "node:http";

const PORT = Number(process.env.PORT ?? 3000);
const key = process.env.AGENT_SANDBOX_API_KEY;
if (!key) throw new Error("AGENT_SANDBOX_API_KEY not set (use --env-file=.env)");

/** Node on Windows cannot resolve {id}.localhost, so connect to 127.0.0.1 and set Host. */
function http(
  method: string,
  host: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const data = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: PORT,
        method,
        path,
        headers: {
          host: `${host}:${PORT}`,
          "content-type": "application/json",
          ...(data ? { "content-length": String(Buffer.byteLength(data)) } : {}),
          ...headers,
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8").on("data", (c) => (text += c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null }),
        );
      },
    );
    req.on("error", reject);
    // Server-side turn limit is 15 min; never wait longer than that.
    req.setTimeout(16 * 60_000, () => req.destroy(new Error(`${method} ${path} timed out`)));
    req.end(data);
  });
}

const api = (method: string, path: string, body?: unknown) =>
  http(method, "localhost", path, { authorization: `Bearer ${key}` }, body);

function show(label: string, started: number, res: { status: number; json: unknown }) {
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n> ${label}\n< ${res.status} (${secs}s) ${JSON.stringify(res.json, null, 2)}`);
}

let t = Date.now();
const created = await api("POST", "/v1/instances", { template: "fx" });
show('POST /v1/instances {"template":"fx"}', t, {
  status: created.status,
  json: { ...created.json, agent_key: "<hidden>" },
});
const { id, agent_key: agentKey } = created.json as { id: string; agent_key: string };
const agent = (method: string, path: string, body?: unknown) =>
  http(method, `${id}.localhost`, path, { "x-agent-key": agentKey }, body);

try {
  // Example 1: wait for health (max 60 s), then the first message.
  t = Date.now();
  let health = await agent("GET", "/v1/health");
  while (!health.json?.healthy) {
    if (health.status !== 200)
      throw new Error(`health returned ${health.status}: ${JSON.stringify(health.json)}`);
    if (health.json?.status === "failed") throw new Error("instance failed");
    if (Date.now() - t > 60_000) throw new Error("instance not healthy after 60 s");
    await new Promise((r) => setTimeout(r, 500));
    health = await agent("GET", "/v1/health");
  }
  show(`GET ${id}.localhost/v1/health (polled until healthy)`, t, health);

  t = Date.now();
  const first = await agent("POST", "/v1/responses", { input: "Say hello in one sentence." });
  show('POST /v1/responses {"input":"Say hello in one sentence."}', t, first);
  const sessionId = first.json.session_id as string;

  t = Date.now();
  const followUp = await agent("POST", "/v1/responses", {
    input: "What did I ask you in my previous message? Answer in one short sentence.",
    session_id: sessionId,
  });
  show("POST /v1/responses (same session, follow-up)", t, followUp);

  // Example 2: the agent writes and runs hello.py.
  t = Date.now();
  const hello = await agent("POST", "/v1/responses", {
    input: "write hello.py in /home/agent that prints hello, then run it",
    session_id: sessionId,
  });
  show("POST /v1/responses (write hello.py and run it)", t, hello);

  t = Date.now();
  const check = await api("POST", `/v1/instances/${id}/exec`, {
    command: "ls /home/agent && python3 /home/agent/hello.py",
  });
  show(`POST /v1/instances/${id}/exec "ls /home/agent && python3 hello.py"`, t, check);

  // Key isolation: what the agent's environment holds.
  const leak = await api("POST", `/v1/instances/${id}/exec`, {
    command: 'echo "$AI_GATEWAY_API_KEY" | cut -c1-24; env | grep -c vck_ || true',
  });
  show("exec: what does the sandbox see as the key? (placeholder prefix, real-key count)", t, leak);

  show(
    `GET /v1/sessions/${sessionId}`,
    Date.now(),
    await agent("GET", `/v1/sessions/${sessionId}`),
  );
} finally {
  t = Date.now();
  show(`DELETE /v1/instances/${id}`, t, await api("DELETE", `/v1/instances/${id}`));
}
