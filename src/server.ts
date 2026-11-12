// Control plane entry point. Run: npm start  (node --env-file=.env src/server.ts)
import { serve } from "@hono/node-server";
import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { HARNESSES } from "./harnesses/index.ts";
import { LocalWindowsHost } from "./hosts/local-windows.ts";
import type { SandboxSecret } from "./hosts/types.ts";
import { InstanceService } from "./instances/service.ts";
import { TEMPLATES } from "./templates.ts";

const config = loadConfig();
const host = new LocalWindowsHost();
const instances = new InstanceService(
  host,
  config.sandboxPrefix,
  (id) => `http://${id}.localhost:${config.port}`,
);

/** The secrets a template's harness needs, with values from this process's env. */
function secretsForTemplate(template: string): SandboxSecret[] {
  const harnessName = TEMPLATES[template]?.harness;
  const harness = harnessName ? HARNESSES[harnessName] : undefined;
  return (harness?.secrets ?? []).map((s) => {
    const value = process.env[s.source];
    if (!value) throw new Error(`Template ${template} needs ${s.source} in .env`);
    return { env: s.env, hosts: s.hosts, value };
  });
}

// Fail at startup, not at first create, if a harness secret is missing.
for (const name of Object.keys(TEMPLATES)) secretsForTemplate(name);

const adopted = await instances.adoptExisting();
// Every 30 s, put instances idle longer than their idle_timeout_seconds to sleep.
instances.startIdleTimer();
const app = buildApp({
  apiKey: config.apiKey,
  instances,
  templates: LocalWindowsHost.templates(),
  harnesses: HARNESSES,
  defaultModel: config.defaultModel,
  sandboxPrefix: config.sandboxPrefix,
  secretsForTemplate,
});

const server = serve({ fetch: app.fetch, port: config.port, hostname: "127.0.0.1" }, (info) => {
  console.log(`agent-sandbox control plane on http://localhost:${info.port} (host: ${host.name})`);
  console.log(`default model: ${config.defaultModel}`);
  if (adopted > 0) console.log(`adopted ${adopted} existing sandbox(es)`);
  console.log("");
  console.log("Waiting for requests. Leave this running; in another terminal try:");
  console.log("  node --env-file=.env scripts/demo-sandbox-api.ts   (sandbox only, no model cost)");
  console.log(
    "  node --env-file=.env scripts/demo-agent.ts         (fx agent, a few model tokens)",
  );
  console.log("Stop with Ctrl+C.");
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `Port ${config.port} is already in use - is another npm start running? ` +
        `Stop it, or start this one on another port with PORT=<n> in .env.`,
    );
  } else {
    console.error(`Server failed to start: ${err.message}`);
  }
  process.exit(1);
});
