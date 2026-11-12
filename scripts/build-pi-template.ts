// Builds the `pi` template: shell sandbox + a pinned Pi, saved with sbx.
// Run: node scripts/build-pi-template.ts   (needed once, and after changing PI_VERSION)
import {
  createSandbox,
  execInSandbox,
  removeSandbox,
  saveTemplate,
  stopSandbox,
} from "../src/lib/sbx.ts";
import { PI_TEMPLATE_TAG, PI_VERSION } from "../src/templates.ts";

const name = `pi-build-${Date.now().toString(36)}`;

async function step(label: string, cmd: string[], user?: string) {
  const result = await execInSandbox(name, cmd, { user, timeoutMs: 5 * 60_000 });
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
  }
  console.log(`  ok: ${label}`);
  return result.stdout;
}

const started = Date.now();
console.log(`building ${PI_TEMPLATE_TAG} in ${name}`);
await createSandbox({ name });
try {
  await step(
    `install pi ${PI_VERSION}`,
    [
      "sh",
      "-c",
      // Pi needs no install scripts (its README); --ignore-scripts keeps the install minimal.
      `npm install -g --ignore-scripts @earendil-works/pi-coding-agent@${PI_VERSION} >/dev/null 2>&1`,
    ],
    "root",
  );
  const version = (await step("pi --version", ["sh", "-c", "pi --version </dev/null"])).trim();
  if (version !== PI_VERSION) throw new Error(`expected pi ${PI_VERSION}, got ${version}`);
  await step("clean pi state", ["sh", "-c", "rm -rf ~/.pi/agent/sessions"]);
  await stopSandbox(name);
  await saveTemplate(name, PI_TEMPLATE_TAG);
  console.log(`saved ${PI_TEMPLATE_TAG} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
} finally {
  await removeSandbox(name);
}
