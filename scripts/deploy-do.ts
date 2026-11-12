// One-command deploy to DigitalOcean, immutable style: build a new droplet from scratch,
// test it, move the reserved IP to it, delete the old droplets. Nothing is patched in place.
// If any step fails the new droplet is deleted and the old one keeps serving.
//
// Run:  npm run deploy:do                      (add --keep-failed to keep a broken droplet for debugging)
//
// Needs: doctl logged in; a clean git tree (the server gets `git archive HEAD`);
//   .env: AGENT_SANDBOX_API_KEY, AI_GATEWAY_API_KEY, DOCKER_USERNAME, DOCKER_PAT
//   optional env: DO_REGION (blr1), DO_SIZE (s-4vcpu-8gb), DEPLOY_SSH_KEY (~/.ssh/loop_deploy,
//   no passphrase; its public key must be added to the DigitalOcean account)
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TAG = "agent-sandbox";
const region = process.env.DO_REGION ?? "blr1";
const size = process.env.DO_SIZE ?? "s-4vcpu-8gb";
const sshKey = process.env.DEPLOY_SSH_KEY ?? join(homedir(), ".ssh", "loop_deploy");
const keepFailed = process.argv.includes("--keep-failed");
/** Keys copied into the server's .env. Docker credentials stay on this laptop. */
const SERVER_ENV = [
  "AGENT_SANDBOX_API_KEY",
  "AGENT_SANDBOX_ADMIN_KEY",
  "AI_GATEWAY_API_KEY",
  "DEFAULT_MODEL",
  "SANDBOX_PREFIX",
];

function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} in .env`);
  return value;
}

interface Run {
  code: number;
  out: string;
  err: string;
}

function run(cmd: string, args: string[], opts: { input?: string; inherit?: boolean } = {}) {
  return new Promise<Run>((resolve, reject) => {
    const child = spawn(cmd, args, {
      windowsHide: true,
      stdio: opts.inherit ? ["pipe", "inherit", "inherit"] : "pipe",
      env: { ...process.env, MSYS_NO_PATHCONV: "1" },
    });
    let out = "";
    let err = "";
    child.stdout?.on("data", (c) => (out += c));
    child.stderr?.on("data", (c) => (err += c));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, out: out.trim(), err: err.trim() }));
    child.stdin?.end(opts.input);
  });
}

async function ok(cmd: string, args: string[], opts: { input?: string; inherit?: boolean } = {}) {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) {
    throw new Error(
      `${cmd} ${args.slice(0, 3).join(" ")} failed (exit ${r.code}): ${r.err || r.out}`,
    );
  }
  return r.out;
}

const doctl = async (...args: string[]) =>
  JSON.parse(await ok("doctl", [...args, "--output", "json"]));

const sshOpts = ["-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "ConnectTimeout=10"];
sshOpts.push("-o", "StrictHostKeyChecking=accept-new", "-i", sshKey);
const ssh = (
  user: string,
  ip: string,
  command: string,
  opts: { input?: string; inherit?: boolean } = {},
) => ok("ssh", [...sshOpts, `${user}@${ip}`, command], opts);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const started = Date.now();
function step(label: string) {
  console.log(`\n[${((Date.now() - started) / 1000).toFixed(0)}s] ${label}`);
}

/** MD5 fingerprint of a public key, the form doctl accepts for --ssh-keys. */
function fingerprint(pubPath: string): string {
  const body = readFileSync(pubPath, "utf8").trim().split(/\s+/)[1];
  if (!body) throw new Error(`Cannot read public key ${pubPath}`);
  return createHash("md5")
    .update(Buffer.from(body, "base64"))
    .digest("hex")
    .match(/../g)!
    .join(":");
}

// --- Preflight: everything that can fail before we spend money.
step("preflight");
const dirty = await ok("git", ["status", "--porcelain"]);
if (dirty)
  throw new Error(`Commit or stash your changes first; the server gets git HEAD.\n${dirty}`);
const commit = await ok("git", ["rev-parse", "--short", "HEAD"]);
const serverEnv = SERVER_ENV.filter((k) => process.env[k])
  .map((k) => `${k}=${process.env[k]}`)
  .join("\n");
need("AGENT_SANDBOX_API_KEY");
need("AI_GATEWAY_API_KEY");
const dockerUser = need("DOCKER_USERNAME");
const dockerPat = need("DOCKER_PAT");
const keyFp = fingerprint(`${sshKey}.pub`);
const accountKeys: { fingerprint: string; name: string }[] = await doctl(
  "compute",
  "ssh-key",
  "list",
);
const accountKey = accountKeys.find((k) => k.fingerprint === keyFp);
if (!accountKey) throw new Error(`${sshKey}.pub (${keyFp}) is not in the DigitalOcean account`);
const before: { id: number; name: string }[] = await doctl(
  "compute",
  "droplet",
  "list",
  "--tag-name",
  TAG,
);
console.log(`  commit ${commit}, ${region}/${size}, ssh key "${accountKey.name}"`);
console.log(`  existing ${TAG} droplets: ${before.map((d) => d.name).join(", ") || "none"}`);

// --- Build the new droplet.
const name = `${TAG}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`;
step(`create droplet ${name} (cloud-init: deploy/cloud-init.yaml)`);
const [created] = await doctl(
  "compute",
  "droplet",
  "create",
  name,
  "--image",
  "ubuntu-24-04-x64",
  "--size",
  size,
  "--region",
  region,
  "--ssh-keys",
  keyFp,
  "--tag-names",
  TAG,
  "--user-data-file",
  "deploy/cloud-init.yaml",
  "--wait",
);
const dropletId = String(created.id);
const ip: string = created.networks.v4.find(
  (n: { type: string }) => n.type === "public",
).ip_address;
console.log(`  id ${dropletId}, ip ${ip}`);
// A recycled IP may still have an old host key in known_hosts.
await run("ssh-keygen", ["-R", ip]);

let succeeded = false;
try {
  step("wait for ssh");
  for (let i = 0; ; i++) {
    if ((await run("ssh", [...sshOpts, `root@${ip}`, "true"])).code === 0) break;
    if (i >= 36) throw new Error("ssh did not come up in 6 minutes");
    await sleep(10_000);
  }

  step("wait for cloud-init (sbx, Node, services; about 2-4 min)");
  const ci = await run("ssh", [...sshOpts, `root@${ip}`, "cloud-init status --wait --long"]);
  console.log(
    ci.out
      .split("\n")
      .filter((l) => /status|errors/.test(l))
      .map((l) => `  ${l.trim()}`)
      .join("\n"),
  );
  if (ci.code !== 0 || !/status: done/.test(ci.out)) {
    const log = await run("ssh", [
      ...sshOpts,
      `root@${ip}`,
      "tail -40 /var/log/cloud-init-output.log",
    ]);
    throw new Error(`cloud-init did not finish cleanly:\n${log.out}`);
  }
  console.log(
    "  " + (await ssh("root", ip, "sbx version; node -v; id sandbox")).replace(/\n/g, "\n  "),
  );

  step("push secrets over ssh (.env, Docker sign-in)");
  await ssh("sandbox", ip, "mkdir -p ~/agent-sandbox && umask 077 && cat > ~/agent-sandbox/.env", {
    input: serverEnv + "\n",
  });
  await ssh("sandbox", ip, `sbx login --username '${dockerUser}' --password-stdin`, {
    input: dockerPat,
  });
  await ssh("sandbox", ip, "sbx policy init allow-all </dev/null");

  step(`copy code (git archive ${commit}), npm ci, npm run check`);
  const archive = spawn("git", ["archive", "--format=tar", "HEAD"], { windowsHide: true });
  const untar = spawn("ssh", [...sshOpts, `sandbox@${ip}`, "tar -x -C ~/agent-sandbox"], {
    windowsHide: true,
    stdio: ["pipe", "inherit", "inherit"],
  });
  archive.stdout.pipe(untar.stdin);
  const untarCode = await new Promise<number>((r) => untar.on("close", (c) => r(c ?? -1)));
  if (untarCode !== 0) throw new Error(`copying code failed (exit ${untarCode})`);
  await ssh("sandbox", ip, `echo ${commit} > ~/agent-sandbox/DEPLOYED_COMMIT`);
  await ssh("sandbox", ip, "cd ~/agent-sandbox && npm ci --no-audit --no-fund --loglevel=error");
  await ssh(
    "sandbox",
    ip,
    "cd ~/agent-sandbox && npm run check --silent >/tmp/check.log 2>&1 || (tail -30 /tmp/check.log; exit 1)",
  );

  step("build fx template");
  await ssh("sandbox", ip, "cd ~/agent-sandbox && node scripts/build-fx-template.ts", {
    inherit: true,
  });

  step("start control plane");
  await ssh(
    "root",
    ip,
    "systemctl enable --now agent-sandbox && sleep 6 && systemctl is-active agent-sandbox",
  );

  step("acceptance: scripts/test-remote.ts against the new droplet");
  const testCode = await new Promise<number>((resolve) => {
    const child = spawn(process.execPath, ["scripts/test-remote.ts"], {
      stdio: "inherit",
      env: { ...process.env, REMOTE_HOST: ip },
    });
    child.on("close", (c) => resolve(c ?? -1));
  });
  if (testCode !== 0) throw new Error("acceptance checks failed");
  succeeded = true;
} finally {
  if (!succeeded) {
    if (keepFailed) {
      console.log(`\nFAILED. Kept ${name} (${ip}) for debugging: ssh -i ${sshKey} root@${ip}`);
    } else {
      console.log(`\nFAILED. Deleting ${name}; the old droplets keep serving.`);
      await run("doctl", ["compute", "droplet", "delete", dropletId, "--force"]);
    }
  }
}

// --- Switch traffic: reserved IP to the new droplet, then retire the old ones.
step("move reserved IP");
const reserved: {
  ip: string;
  region: { slug: string };
  droplet?: { id: number; tags?: string[] };
}[] = await doctl("compute", "reserved-ip", "list");
let stableIp = reserved.find((r) => r.droplet?.tags?.includes(TAG))?.ip;
if (stableIp) {
  await ok("doctl", ["compute", "reserved-ip-action", "assign", stableIp, dropletId]);
} else {
  const [made] = await doctl("compute", "reserved-ip", "create", "--droplet-id", dropletId);
  stableIp = made.ip as string;
  console.log(`  created reserved IP ${stableIp}`);
}
// doctl has no --wait for reserved IP actions; poll until it points at the new droplet.
for (let i = 0; ; i++) {
  const [state] = await doctl("compute", "reserved-ip", "get", stableIp);
  if (String(state?.droplet?.id) === dropletId) break;
  if (i >= 60) throw new Error(`reserved IP ${stableIp} not on ${name} after 2 minutes`);
  await sleep(2000);
}
console.log(`  ${stableIp} -> ${name}`);
await run("ssh-keygen", ["-R", stableIp]);

step("retire old droplets");
for (const old of before) {
  await ok("doctl", ["compute", "droplet", "delete", String(old.id), "--force"]);
  console.log(`  deleted ${old.name}`);
}

step("smoke test through the reserved IP");
const finalCode = await new Promise<number>((resolve) => {
  const child = spawn(process.execPath, ["scripts/test-remote.ts", "--skip-agent"], {
    stdio: "inherit",
    env: { ...process.env, REMOTE_HOST: stableIp },
  });
  child.on("close", (c) => resolve(c ?? -1));
});

console.log(
  `\nDEPLOYED ${commit} to ${name} in ${((Date.now() - started) / 60000).toFixed(1)} min`,
);
console.log(`  address: ${stableIp} (reserved IP; stays the same across deploys)`);
console.log(`  test:    REMOTE_HOST=${stableIp} node --env-file=.env scripts/test-remote.ts`);
console.log(`  ssh:     ssh -i ${sshKey} sandbox@${stableIp}`);
process.exit(finalCode);
