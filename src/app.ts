// Builds the HTTP app. Kept separate from server.ts so tests can call it without a socket.
//   api host (localhost:3000)         -> Sandbox API, Authorization: Bearer <key>
//   {id}.localhost:3000               -> Agent API for that instance, X-Agent-Key
import { timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { ZodError } from "zod";
import { agentApp } from "./api/agent.ts";
import { instancesRoutes } from "./api/instances.ts";
import type { HarnessAdapter } from "./harnesses/types.ts";
import { SbxError } from "./lib/sbx.ts";
import { ApiError, type InstanceService } from "./instances/service.ts";

export interface AppDeps {
  apiKey: string;
  instances: InstanceService;
  templates: string[];
  harnesses: Record<string, HarnessAdapter>;
  defaultModel: string;
  /** Sandbox name prefix; agent hosts look like `<prefix>xxxx.localhost`. */
  sandboxPrefix: string;
  /** Resolve template secrets from host env vars. */
  secretsForTemplate: (template: string) => { env: string; hosts: string[]; value: string }[];
}

function sameKey(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function handleError(err: Error, c: Context) {
  if (err instanceof ApiError) {
    return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
  }
  if (err instanceof ZodError) {
    return c.json(
      { error: { code: "invalid_request", message: "Invalid body", issues: err.issues } },
      400,
    );
  }
  if (err instanceof SbxError) {
    console.error(err.message);
    return c.json({ error: { code: "sandbox_host_error", message: err.message } }, 502);
  }
  if (err instanceof SyntaxError) {
    return c.json({ error: { code: "invalid_json", message: "Body is not valid JSON" } }, 400);
  }
  console.error(err);
  return c.json({ error: { code: "internal_error", message: "Internal error" } }, 500);
}

/** `sb-abc123.localhost:3000` -> `sb-abc123`. */
export function agentHostId(host: string | undefined, prefix: string): string | undefined {
  const name = (host ?? "").toLowerCase().split(":")[0] ?? "";
  const [label, ...rest] = name.split(".");
  if (!label || rest.length === 0 || !label.startsWith(prefix)) return undefined;
  return label;
}

export function buildApp(deps: AppDeps) {
  const app = new Hono();
  const agent = agentApp(deps);
  agent.onError(handleError);
  agent.notFound((c) => c.json({ error: { code: "not_found", message: "No such route" } }, 404));

  // Router: instance subdomains go to the Agent API.
  app.use("*", async (c, next) => {
    const instanceId = agentHostId(c.req.header("host"), deps.sandboxPrefix);
    if (!instanceId) return next();
    return agent.fetch(c.req.raw, { instanceId });
  });

  app.use("/v1/*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!sameKey(token, deps.apiKey)) {
      return c.json(
        { error: { code: "unauthorized", message: "Missing or invalid API key" } },
        401,
      );
    }
    await next();
  });

  app.route(
    "/v1/instances",
    instancesRoutes(deps.instances, deps.templates, deps.secretsForTemplate),
  );

  app.notFound((c) => c.json({ error: { code: "not_found", message: "No such route" } }, 404));
  app.onError(handleError);

  return app;
}
