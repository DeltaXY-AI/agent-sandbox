// Builds the `eve` template: shell sandbox + Node 24 + the default eve agent project
// (templates/eve/project), installed and built, + the turn shim. Saved with sbx.
// Run: node scripts/build-eve-template.ts   (needed once, and after changing templates/eve/)
import {
  copyToSandbox,
  createSandbox,
  execInSandbox,
  removeSandbox,
  saveTemplate,
  stopSandbox,
} from "../src/lib/sbx.ts";
import { EVE_NODE_VERSION, EVE_TEMPLATE_TAG, EVE_VERSION } from "../src/templates.ts";

const name = `eve-build-${Date.now().toString(36)}`;
const NODE_DIR = `node-v${EVE_NODE_VERSION}-linux-x64`;
const PATH = "/opt/node24/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const PROJECT = "/home/agent/eve-agent";

async function step(label: string, cmd: string[], user?: string, workdir?: string) {
  const result = await execInSandbox(name, cmd, {
    user,
    workdir,
    env: { PATH, EVE_TELEMETRY_DISABLED: "1" },
    timeoutMs: 10 * 60_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
  }
  console.log(`  ok: ${label}`);
  return result.stdout;
}

const started = Date.now();
console.log(`building ${EVE_TEMPLATE_TAG} in ${name}`);
await createSandbox({ name });
try {
  await step(
    `install node ${EVE_NODE_VERSION}`,
    [
      "sh",
      "-c",
      `curl -fsSL https://nodejs.org/dist/v${EVE_NODE_VERSION}/${NODE_DIR}.tar.xz | tar -xJ -C /opt` +
        ` && ln -sfn /opt/${NODE_DIR} /opt/node24 && mkdir -p /opt/agent-sandbox`,
    ],
    "root",
  );
  await copyToSandbox(name, "templates/eve/project", PROJECT);
  await copyToSandbox(name, "templates/eve/eve-turn.mjs", "/opt/agent-sandbox/eve-turn.mjs");
  await step(
    "ownership",
    ["sh", "-c", `chown -R agent:agent ${PROJECT} && chmod 755 /opt/agent-sandbox/eve-turn.mjs`],
    "root",
  );
  await step("npm install", ["npm", "install", "--no-audit", "--no-fund"], undefined, PROJECT);
  const version = (
    await step(
      "eve version",
      ["node", "-p", "require('eve/package.json').version"],
      undefined,
      PROJECT,
    )
  ).trim();
  if (version !== EVE_VERSION) throw new Error(`expected eve ${EVE_VERSION}, got ${version}`);
  await step("eve build", ["npx", "eve", "build"], undefined, PROJECT);
  await step("shim parses", ["node", "--check", "/opt/agent-sandbox/eve-turn.mjs"]);
  // The built server must start and answer health before we save it.
  await step(
    "eve start answers health",
    [
      "sh",
      "-c",
      "npx eve start --host 127.0.0.1 --port 7700 >/tmp/eve-check.log 2>&1 & pid=$!; " +
        "for i in $(seq 1 60); do curl -sf -m 1 http://127.0.0.1:7700/eve/v1/health && break; sleep 0.5; done; " +
        "ok=$?; kill $pid; wait $pid 2>/dev/null; exit $ok",
    ],
    undefined,
    PROJECT,
  );
  // No sessions from the health check may ship in the template.
  await step("clean eve state", [
    "sh",
    "-c",
    `rm -rf ${PROJECT}/.eve/.workflow-data /tmp/eve-check.log`,
  ]);
  await stopSandbox(name);
  await saveTemplate(name, EVE_TEMPLATE_TAG);
  console.log(`saved ${EVE_TEMPLATE_TAG} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
} finally {
  await removeSandbox(name);
}
