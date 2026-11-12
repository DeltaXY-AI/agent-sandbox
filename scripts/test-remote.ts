// Tests a deployed control plane (for example the DigitalOcean droplet) from this laptop.
// Opens an SSH tunnel to the server's 127.0.0.1:3000, runs checks, prints PASS/FAIL, closes the tunnel.
//
// Run (PowerShell): $env:REMOTE_HOST = "<ip>"; npm run test:remote
// Run (Git Bash):   REMOTE_HOST=<ip> npm run test:remote
//       add `-- --skip-agent` to skip the fx agent turn (no model tokens)
//
// Env:  REMOTE_HOST (required), REMOTE_USER (default sandbox),
//       REMOTE_SSH_KEY (default ~/.ssh/loop_deploy), LOCAL_PORT (default 3300),
//       AGENT_SANDBOX_API_KEY (from .env; must match the server's .env)
import { spawn } from "node:child_process";
import { request } from "node:http";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const remoteHost = process.env.REMOTE_HOST;
if (!remoteHost) throw new Error("Set REMOTE_HOST, e.g. REMOTE_HOST=139.59.5.128");
const remoteUser = process.env.REMOTE_USER ?? "sandbox";
const sshKey = process.env.REMOTE_SSH_KEY ?? join(homedir(), ".ssh", "loop_deploy");
const PORT = Number(process.env.LOCAL_PORT ?? 3300);
const key = process.env.AGENT_SANDBOX_API_KEY;
if (!key) throw new Error("AGENT_SANDBOX_API_KEY not set (use --env-file=.env)");
const skipAgent = process.argv.includes("--skip-agent");

const sshBase = ["-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "ConnectTimeout=10"];
sshBase.push("-o", "StrictHostKeyChecking=accept-new", "-i", sshKey);
const target = `${remoteUser}@${remoteHost}`;

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
}

/** Run one command on the server over SSH. Only stdout is parsed; ssh's own notices go to stderr. */
function ssh(command: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn("ssh", [...sshBase, target, command], { windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (code) => resolve({ code: code ?? -1, out: out.trim(), err: err.trim() }));
  });
}

function portOpen(): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect(PORT, "127.0.0.1");
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
  });
}

/** Connect to 127.0.0.1 and set Host, because Node cannot resolve {id}.localhost on Windows. */
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
        res.on("end", () => {
          let json: any;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = text;
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(16 * 60_000, () => req.destroy(new Error(`${method} ${path} timed out`)));
    req.end(data);
  });
}

const api = (method: string, path: string, body?: unknown) =>
  http(method, "localhost", path, { authorization: `Bearer ${key}` }, body);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(id: string, status: string, timeoutMs = 120_000) {
  const t = Date.now();
  while (Date.now() - t < timeoutMs) {
    const res = await api("GET", `/v1/instances/${id}`);
    if (res.json?.status === status) return true;
    if (res.json?.status === "failed") return false;
    await sleep(1000);
  }
  return false;
}

// 1. Server side: services and sbx.
console.log(`== server ${target}`);
const services = await ssh("systemctl is-active sbx-daemon agent-sandbox; sbx version");
// `systemctl is-active` exits non-zero when a unit is down, so judge reachability by output.
check("ssh reachable", services.out.length > 0, services.out ? "" : services.err.slice(0, 200));
const lines = services.out.split("\n");
check("sbx-daemon service active", lines[0] === "active", lines[0]);
check("agent-sandbox service active", lines[1] === "active", lines[1]);
check("sbx version v0.50.1", (lines[2] ?? "").includes("v0.50.1"), lines[2]);

// 2. Tunnel.
if (await portOpen()) throw new Error(`Local port ${PORT} is busy. Set LOCAL_PORT to a free port.`);
const tunnel = spawn("ssh", [...sshBase, "-N", "-L", `${PORT}:127.0.0.1:3000`, target], {
  windowsHide: true,
  stdio: "ignore",
});
try {
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await sleep(250);
    up = await portOpen();
  }
  check(`ssh tunnel localhost:${PORT} -> server 127.0.0.1:3000`, up);
  if (!up) throw new Error("tunnel did not open");

  // 3. Sandbox API on the base template.
  console.log("\n== sandbox API (base template)");
  const unauth = await http("GET", "localhost", "/v1/instances", {});
  check("no API key -> 401", unauth.status === 401, `got ${unauth.status}`);
  const list = await api("GET", "/v1/instances");
  check("GET /v1/instances -> 200", list.status === 200, `got ${list.status}`);

  let t = Date.now();
  const created = await api("POST", "/v1/instances", { template: "base" });
  check("POST /v1/instances base -> 201", created.status === 201, `got ${created.status}`);
  const id = created.json?.id as string;
  try {
    check("instance reaches running", await waitFor(id, "running"), `${Date.now() - t} ms`);
    const os = await api("POST", `/v1/instances/${id}/exec`, {
      command: ". /etc/os-release; echo $ID; whoami",
    });
    check(
      "exec: Ubuntu, user agent",
      os.json?.exit_code === 0 && os.json.stdout === "ubuntu\nagent\n",
      JSON.stringify(os.json?.stdout),
    );
    const code = await api("POST", `/v1/instances/${id}/exec`, { command: "exit 3" });
    check("exec returns exit code 3", code.json?.exit_code === 3, `got ${code.json?.exit_code}`);
    await api("POST", `/v1/instances/${id}/exec`, { command: "echo kept > ~/note.txt" });
    const slept = await api("POST", `/v1/instances/${id}/sleep`);
    check("sleep -> sleeping", slept.json?.status === "sleeping", slept.json?.status);
    t = Date.now();
    const kept = await api("POST", `/v1/instances/${id}/exec`, { command: "cat ~/note.txt" });
    check(
      "exec on sleeping instance wakes it; file survived",
      kept.json?.stdout === "kept\n",
      `${Date.now() - t} ms`,
    );
    await api("POST", `/v1/instances/${id}/stop`);
    const off = await api("POST", `/v1/instances/${id}/exec`, { command: "true" });
    check(
      "exec on stopped instance -> 409 instance_stopped",
      off.status === 409,
      `got ${off.status}`,
    );
  } finally {
    const del = await api("DELETE", `/v1/instances/${id}`);
    check("DELETE instance -> 204", del.status === 204, `got ${del.status}`);
  }
  const gone = await api("GET", `/v1/instances/${id}`);
  check("deleted instance -> 404", gone.status === 404, `got ${gone.status}`);

  // 4. Agent API on fx.
  if (skipAgent) {
    console.log("\n== agent API skipped (--skip-agent)");
  } else {
    console.log("\n== agent API (fx template, costs a few model tokens)");
    const fx = await api("POST", "/v1/instances", { template: "fx" });
    check("POST /v1/instances fx -> 201", fx.status === 201, `got ${fx.status}`);
    const fxId = fx.json?.id as string;
    const agent = (method: string, path: string, body?: unknown) =>
      http(method, `${fxId}.localhost`, path, { "x-agent-key": fx.json?.agent_key }, body);
    try {
      t = Date.now();
      let healthy = false;
      while (!healthy && Date.now() - t < 120_000) {
        healthy = (await agent("GET", "/v1/health")).json?.healthy === true;
        if (!healthy) await sleep(500);
      }
      check("GET {id}.localhost/v1/health -> healthy", healthy, `${Date.now() - t} ms`);

      t = Date.now();
      const turn = await agent("POST", "/v1/responses", {
        input: "write hello.py in /home/agent that prints hello, then run it",
      });
      check(
        "POST /v1/responses completes",
        turn.status === 200 && turn.json?.status === "completed",
        `${turn.status} ${turn.json?.status ?? ""} ${Date.now() - t} ms`,
      );
      const run = await api("POST", `/v1/instances/${fxId}/exec`, {
        command: "python3 /home/agent/hello.py",
      });
      check(
        "hello.py prints hello",
        run.json?.exit_code === 0 && /hello/i.test(run.json?.stdout ?? ""),
        JSON.stringify(run.json?.stdout),
      );
      const leak = await api("POST", `/v1/instances/${fxId}/exec`, {
        command: "env | grep -c vck_ || true",
      });
      check("real gateway key not in sandbox env", leak.json?.stdout?.trim() === "0");
    } finally {
      const del = await api("DELETE", `/v1/instances/${fxId}`);
      check("DELETE fx instance -> 204", del.status === 204, `got ${del.status}`);
    }
  }
} finally {
  tunnel.kill();
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
