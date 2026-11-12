// Builds the `fx` template: shell sandbox + pinned fx + gateway relay, saved with sbx.
// Run: node scripts/build-fx-template.ts
import {
  copyToSandbox,
  createSandbox,
  execInSandbox,
  removeSandbox,
  saveTemplate,
  stopSandbox,
} from "../src/lib/sbx.ts";
import { FX_TEMPLATE_TAG, FX_VERSION } from "../src/templates.ts";

const name = `fx-build-${Date.now().toString(36)}`;

async function step(label: string, cmd: string[], user?: string) {
  const result = await execInSandbox(name, cmd, { user, timeoutMs: 5 * 60_000 });
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
  }
  console.log(`  ok: ${label}`);
  return result.stdout;
}

const started = Date.now();
console.log(`building ${FX_TEMPLATE_TAG} in ${name}`);
await createSandbox({ name });
try {
  await step("create /opt/agent-sandbox", ["sh", "-c", "mkdir -p /opt/agent-sandbox"], "root");
  await step(
    `install fx ${FX_VERSION}`,
    [
      "sh",
      "-c",
      `curl -fsSL https://fx.sh/setup.sh -o /tmp/fx-setup.sh && ` +
        `FX_INSTALL_DIR=/usr/local/bin bash /tmp/fx-setup.sh v${FX_VERSION} </dev/null >/dev/null 2>&1 && ` +
        `rm /tmp/fx-setup.sh`,
    ],
    "root",
  );
  await copyToSandbox(name, "templates/fx/fx-turn.mjs", "/opt/agent-sandbox/fx-turn.mjs");
  await step(
    "permissions, CRLF guard",
    [
      "sh",
      "-c",
      "sed -i 's/\\r$//' /opt/agent-sandbox/fx-turn.mjs && chmod 755 /opt/agent-sandbox/*",
    ],
    "root",
  );
  await step("fx-turn.mjs parses", ["node", "--check", "/opt/agent-sandbox/fx-turn.mjs"]);
  const version = (await step("fx --version", ["fx", "--version"])).trim();
  if (version !== FX_VERSION) throw new Error(`expected fx ${FX_VERSION}, got ${version}`);
  await step("clean fx state", ["sh", "-c", "rm -rf ~/.fx/sessions ~/.fx/logs /tmp/*.log"]);
  await stopSandbox(name);
  await saveTemplate(name, FX_TEMPLATE_TAG);
  console.log(`saved ${FX_TEMPLATE_TAG} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
} finally {
  await removeSandbox(name);
}
