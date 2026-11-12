// Demo: keys and workspaces, as a six-act story. Needs a running server (npm start).
// Run:  npm run demo:workspaces            (add `-- --pause` to wait for Enter between acts)
// Env:  AGENT_SANDBOX_ADMIN_KEY, PORT (default 3000), DATABASE_PATH (default data/agent-sandbox.db)
// Creates two workspaces and two small sandboxes, and deletes the sandboxes at the end.
// No model tokens.
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { Store } from "../src/store/store.ts";

const PORT = Number(process.env.PORT ?? 3000);
const API = `http://localhost:${PORT}`;
const ADMIN = process.env.AGENT_SANDBOX_ADMIN_KEY;
const DB = process.env.DATABASE_PATH ?? "data/agent-sandbox.db";
if (!ADMIN) throw new Error("AGENT_SANDBOX_ADMIN_KEY not set (use --env-file=.env)");
const pause = process.argv.includes("--pause");

async function call(method: string, path: string, key: string, body?: unknown) {
  const res = await fetch(API + path, {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

const short = (v: unknown) => {
  const s = JSON.stringify(v);
  return s.length > 150 ? `${s.slice(0, 150)}...` : s;
};
function show(what: string, res: { status: number; json: unknown }) {
  console.log(`  > ${what}`);
  console.log(`    ${res.status} ${short(res.json)}`);
}
function say(text: string) {
  console.log(`  ${text}`);
}
async function act(n: number, title: string) {
  if (pause && n > 1) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    await rl.question("\n  (Enter for the next act) ");
    rl.close();
  }
  console.log(`\n=== Act ${n}: ${title} ===`);
}
async function waitRunning(id: string, key: string) {
  for (let t = Date.now(); Date.now() - t < 120_000;) {
    if ((await call("GET", `/v1/instances/${id}`, key)).json?.status === "running") return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${id} did not start`);
}
const exec = (id: string, key: string, command: string) =>
  call("POST", `/v1/instances/${id}/exec`, key, { command });

const health = await fetch(`${API}/v1/instances`).catch(() => undefined);
if (!health) throw new Error(`No server on ${API}. Start it first: npm start`);

console.log("Keys and workspaces: two companies sign up to your platform.");
console.log("You hold the admin key. Each company gets its own workspace and API key.");

const stamp = Date.now().toString(36);
let northwindKey = "";
let contosoKey = "";
let nwSandbox = "";
let coSandbox = "";
let nwId: string;
try {
  await act(1, "your sign-up system creates two customers");
  const nw = await call("POST", "/v1/admin/workspaces", ADMIN, { name: `Northwind ${stamp}` });
  const co = await call("POST", "/v1/admin/workspaces", ADMIN, { name: `Contoso ${stamp}` });
  show("POST /v1/admin/workspaces {name: Northwind}  (admin key)", nw);
  show("POST /v1/admin/workspaces {name: Contoso}    (admin key)", co);
  nwId = nw.json.workspace.id;
  northwindKey = nw.json.api_key.key;
  contosoKey = co.json.api_key.key;
  const nwKeyId = nw.json.api_key.id;
  say(`Northwind's key: ${northwindKey.slice(0, 20)}...  (shown once, stored only as a hash)`);
  show(
    `GET /v1/admin/workspaces/${nwId}  (the key appears only as a prefix)`,
    await call("GET", `/v1/admin/workspaces/${nwId}`, ADMIN),
  );
  const asCustomer = await call("GET", "/v1/admin/workspaces", contosoKey);
  show(
    "GET /v1/admin/workspaces with Contoso's key (customers cannot use the admin API)",
    asCustomer,
  );

  await act(2, "Northwind builds something");
  const created = await call("POST", "/v1/instances", northwindKey, { template: "base" });
  nwSandbox = created.json.id;
  show("POST /v1/instances  (Northwind's key)", created);
  await waitRunning(nwSandbox, northwindKey);
  show(
    "exec: echo northwind-secret > ~/plans.txt",
    await exec(nwSandbox, northwindKey, "echo northwind-secret > ~/plans.txt && cat ~/plans.txt"),
  );

  await act(3, "Contoso tries to look (the door is closed)");
  show(
    "GET /v1/instances  (Contoso's key: an empty list)",
    await call("GET", "/v1/instances", contosoKey),
  );
  show(
    `exec in ${nwSandbox}: cat ~/plans.txt  (Contoso's key)`,
    await exec(nwSandbox, contosoKey, "cat ~/plans.txt"),
  );
  show(
    `DELETE /v1/instances/${nwSandbox}  (Contoso's key)`,
    await call("DELETE", `/v1/instances/${nwSandbox}`, contosoKey),
  );
  say("404, not 403: Contoso cannot even tell that Northwind's sandbox exists.");

  await act(4, "Contoso tries the back door, from inside its own sandbox");
  const mine = await call("POST", "/v1/instances", contosoKey, { template: "base" });
  coSandbox = mine.json.id;
  show("POST /v1/instances  (Contoso's own sandbox)", mine);
  await waitRunning(coSandbox, contosoKey);
  const ipA = (
    await exec(nwSandbox, northwindKey, "hostname -I | cut -d' ' -f1")
  ).json.stdout.trim();
  const probe = await exec(
    coSandbox,
    contosoKey,
    `for u in http://host.docker.internal:${PORT}/v1/instances http://localhost:${PORT}/v1/instances ` +
      `http://${ipA}:8080/ https://example.com/; do printf '%s -> ' "$u"; ` +
      `curl -s -m 5 -o /dev/null -w '%{http_code}\\n' "$u"; done`,
  );
  say("From inside Contoso's sandbox (000 = no connection, 403 = blocked by the rule):");
  for (const line of String(probe.json.stdout).trim().split("\n")) say(`  ${line}`);
  say("Your server and Northwind's sandbox are out of reach; the internet still works.");

  await act(5, "Northwind's key leaks, and you revoke it");
  show(
    "Northwind's key works: GET /v1/instances",
    await call("GET", "/v1/instances", northwindKey),
  );
  show(
    `DELETE /v1/admin/workspaces/${nwId}/keys/${nwKeyId}  (admin key)`,
    await call("DELETE", `/v1/admin/workspaces/${nwId}/keys/${nwKeyId}`, ADMIN),
  );
  show("The leaked key now: GET /v1/instances", await call("GET", "/v1/instances", northwindKey));
  const fresh = await call("POST", `/v1/admin/workspaces/${nwId}/keys`, ADMIN, { name: "rotated" });
  show(`POST /v1/admin/workspaces/${nwId}/keys  (a new key for Northwind)`, fresh);
  northwindKey = fresh.json.key;
  show(
    "Northwind's sandbox and data are untouched (new key): cat ~/plans.txt",
    await exec(nwSandbox, northwindKey, "cat ~/plans.txt"),
  );

  await act(6, "a restart loses nothing: it is all in the database");
  const store = new Store(DB);
  const record = store.loadInstances().find((r) => r.id === coSandbox);
  store.close();
  say(`${DB} holds Contoso's sandbox record, which the server reloads after a restart:`);
  say(
    `  ${short({ id: record?.id, workspace_id: record?.workspace_id, template: record?.template, agent_key: `${record?.agent_key.slice(0, 10)}...` })}`,
  );
  const raw = readFileSync(DB);
  let wal = Buffer.alloc(0);
  try {
    wal = readFileSync(`${DB}-wal`);
  } catch {
    // no write-ahead log yet
  }
  const leaked = raw.includes(Buffer.from(contosoKey)) || wal.includes(Buffer.from(contosoKey));
  say(
    `Does the database file contain Contoso's plain API key? ${leaked ? "YES (bad)" : "no, only its hash"}`,
  );
  say("To see it for real: restart npm start, then GET the sandbox again with Contoso's key.");
} finally {
  console.log("\n=== Clean up ===");
  if (nwSandbox)
    show(`DELETE ${nwSandbox}`, await call("DELETE", `/v1/instances/${nwSandbox}`, northwindKey));
  if (coSandbox)
    show(`DELETE ${coSandbox}`, await call("DELETE", `/v1/instances/${coSandbox}`, contosoKey));
  console.log("  (The two demo workspaces stay; workspaces cannot be deleted yet.)");
}
