// Demo: the bare Sandbox API against a running server (npm start).
// Run: node --env-file=.env scripts/demo-sandbox-api.ts
const base = process.env.API_URL ?? "http://localhost:3000";
const key = process.env.AGENT_SANDBOX_API_KEY;
if (!key) throw new Error("AGENT_SANDBOX_API_KEY not set (use --env-file=.env)");

async function call(method: string, path: string, body?: unknown) {
  const started = Date.now();
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n> ${method} ${path}${body ? " " + JSON.stringify(body) : ""}`);
  console.log(`< ${res.status} (${secs}s) ${text}`);
  return text ? JSON.parse(text) : undefined;
}

async function waitFor(id: string, status: string) {
  for (let i = 0; i < 120; i++) {
    const res = await fetch(`${base}/v1/instances/${id}`, {
      headers: { authorization: `Bearer ${key}` },
    });
    const inst = (await res.json()) as { status: string; error?: string };
    if (inst.status === status) return;
    if (inst.status === "failed") throw new Error(`instance failed: ${inst.error}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timed out waiting for ${status}`);
}

// Auth check: no key -> 401
const noKey = await fetch(`${base}/v1/instances`);
console.log(`> GET /v1/instances without key\n< ${noKey.status} ${await noKey.text()}`);

const created = await call("POST", "/v1/instances", { template: "base" });
const id = created.id as string;
const t0 = Date.now();
await waitFor(id, "running");
console.log(`\n(running after ${((Date.now() - t0) / 1000).toFixed(1)}s of polling)`);

try {
  await call("POST", `/v1/instances/${id}/exec`, {
    command: "uname -sr; . /etc/os-release; echo $PRETTY_NAME; whoami",
  });
  await call("POST", `/v1/instances/${id}/exec`, {
    command: "echo 'survives stop' > ~/note.txt && ls ~",
  });
  await call("POST", `/v1/instances/${id}/exec`, { command: "exit 3" });
  await call("POST", `/v1/instances/${id}/stop`);
  await call("POST", `/v1/instances/${id}/exec`, { command: "cat ~/note.txt" });
  await call("POST", `/v1/instances/${id}/stop`);
  await call("POST", `/v1/instances/${id}/start`);
  await call("GET", "/v1/instances");
  await call("GET", "/v1/instances/sb-doesnotexist");
  await call("POST", "/v1/instances", { template: "nope" });
} finally {
  await call("DELETE", `/v1/instances/${id}`);
  await call("GET", `/v1/instances/${id}`);
}
