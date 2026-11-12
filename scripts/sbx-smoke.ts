// Weekend 1 task 1: drive sbx from Node. Creates one sandbox and removes it.
// Run: node scripts/sbx-smoke.ts
import {
  createSandbox,
  execInSandbox,
  findSandbox,
  removeSandbox,
  startSandbox,
  stopSandbox,
} from "../src/lib/sbx.ts";

const name = `smoke-${Date.now().toString(36)}`;

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  const value = await fn();
  console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${label}`);
  return value;
}

try {
  const sandbox = await timed(`create ${name}`, () => createSandbox({ name }));
  console.log("  ", JSON.stringify(sandbox));

  const ls = await timed("exec ls -la /home/agent", () =>
    execInSandbox(name, ["ls", "-la", "/home/agent"]),
  );
  console.log(`   exit=${ls.exitCode}\n${ls.stdout}`);

  await timed("exec write marker file", () =>
    execInSandbox(name, ["sh", "-c", "echo kept > /home/agent/marker.txt"]),
  );

  const failing = await execInSandbox(name, ["sh", "-c", "echo to-stderr >&2; exit 7"]);
  console.log(`   failing command: exit=${failing.exitCode} stderr=${failing.stderr.trim()}`);

  await timed("stop", () => stopSandbox(name));
  console.log("   status after stop:", (await findSandbox(name))?.status);

  const afterStop = await timed("exec on stopped sandbox (auto-start)", () =>
    execInSandbox(name, ["cat", "/home/agent/marker.txt"]),
  );
  console.log(`   exit=${afterStop.exitCode}`);
  console.log(`   stdout=${JSON.stringify(afterStop.stdout)}`);
  console.log(`   stderr=${JSON.stringify(afterStop.stderr)}`);
  console.log("   status now:", (await findSandbox(name))?.status);

  await timed("start (already running, no-op exec)", () => startSandbox(name));
} finally {
  await timed(`remove ${name}`, () => removeSandbox(name)).catch((err: unknown) =>
    console.error("cleanup failed:", err),
  );
  console.log("   still listed:", Boolean(await findSandbox(name)));
}
