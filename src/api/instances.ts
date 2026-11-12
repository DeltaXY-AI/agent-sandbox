// Sandbox API: /v1/instances (SPEC section 3).
import { Hono } from "hono";
import { z } from "zod";
import type { SandboxSecret } from "../hosts/types.ts";
import {
  DEFAULT_IDLE_TIMEOUT_SECONDS,
  MAX_IDLE_TIMEOUT_SECONDS,
  MIN_IDLE_TIMEOUT_SECONDS,
  type InstanceService,
} from "../instances/service.ts";
import {
  SIGNED_URL_DEFAULT_TTL,
  SIGNED_URL_MAX_TTL,
  SIGNED_URL_MIN_TTL,
  TOKEN_PARAM,
  type PublicPort,
  type PublicPorts,
  type UrlSigner,
} from "../router/ports.ts";
import type { Meter } from "../meter/meter.ts";
import { usageWindow } from "./usage.ts";

const port = z.number().int().min(1).max(65_535);
const publicPortBody = z.object({
  port,
  prefix: z
    .string()
    .regex(/^[a-z0-9-]{1,30}$/, "1-30 lowercase letters, digits or hyphens")
    .optional(),
  label: z.string().max(100).optional(),
});
const signedUrlBody = z.object({
  port,
  ttl_seconds: z.number().int().default(SIGNED_URL_DEFAULT_TTL),
});

export interface PortsDeps {
  publicPorts: PublicPorts;
  signer: UrlSigner;
  hostUrl: (label: string) => string;
  meter: Meter;
}

const createBody = z.object({
  template: z.string().default("base"),
  env: z.record(z.string(), z.string()).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  resources: z
    .object({ cpu: z.number().int().positive().optional(), memory: z.string().optional() })
    .optional(),
  idle_timeout_seconds: z
    .number()
    .int()
    .min(MIN_IDLE_TIMEOUT_SECONDS)
    .max(MAX_IDLE_TIMEOUT_SECONDS)
    .default(DEFAULT_IDLE_TIMEOUT_SECONDS),
  /** Permanent unauthenticated URLs (webhooks). */
  public_ports: z.array(publicPortBody).max(50).default([]),
});

const execBody = z.object({
  /** A string runs through `sh -c`; an array runs as-is. */
  command: z.union([z.string().min(1), z.array(z.string()).min(1)]),
  user: z.string().optional(),
  workdir: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  stdin: z.string().optional(),
  timeout_seconds: z.number().positive().max(3600).default(300),
});

export function instancesRoutes(
  service: InstanceService,
  templates: string[],
  secretsForTemplate: (template: string) => SandboxSecret[],
  ports: PortsDeps,
) {
  // workspaceId is set by the API-key middleware in app.ts.
  const app = new Hono<{ Variables: { workspaceId: string } }>();

  // Every /:id route acts only on the caller's own instances; others are 404.
  const ownedOnly = async (
    c: { req: { param(name: "id"): string }; get(key: "workspaceId"): string },
    next: () => Promise<void>,
  ) => {
    service.owned(c.req.param("id"), c.get("workspaceId"));
    await next();
  };
  app.use("/:id", ownedOnly);
  app.use("/:id/*", ownedOnly);
  const showPort = (p: PublicPort) => ({
    port: p.port,
    prefix: p.prefix,
    label: p.label,
    url: ports.hostUrl(p.host_label),
    created_at: p.created_at,
  });

  app.post("/", async (c) => {
    const body = createBody.parse(await c.req.json().catch(() => ({})));
    if (!templates.includes(body.template)) {
      return c.json(
        {
          error: {
            code: "unknown_template",
            message: `Template ${body.template} not found. Available: ${templates.join(", ")}`,
          },
        },
        400,
      );
    }
    const secrets = secretsForTemplate(body.template);
    const { public_ports: wanted, ...rest } = body;
    // Check before creating anything: duplicates are the only way adding can fail here.
    const seen = new Set<string>();
    for (const p of wanted) {
      for (const key of [`port:${p.port}`, p.prefix ? `prefix:${p.prefix}` : ""]) {
        if (key && seen.has(key)) {
          return c.json(
            { error: { code: "public_port_exists", message: `Duplicate ${key}` } },
            409,
          );
        }
        seen.add(key);
      }
    }
    const instance = service.create({ ...rest, secrets, workspace_id: c.get("workspaceId") });
    for (const p of wanted) ports.publicPorts.add(instance.id, p);
    return c.json(
      { ...instance, public_ports: ports.publicPorts.list(instance.id).map(showPort) },
      201,
    );
  });

  app.get("/", async (c) => {
    await service.refresh();
    return c.json({ data: service.list(c.get("workspaceId")) });
  });

  app.get("/:id", async (c) => {
    await service.refresh();
    return c.json(service.get(c.req.param("id")));
  });

  app.post("/:id/exec", async (c) => {
    const body = execBody.parse(await c.req.json());
    const cmd = typeof body.command === "string" ? ["sh", "-c", body.command] : body.command;
    const result = await service.exec(c.req.param("id"), {
      cmd,
      user: body.user,
      workdir: body.workdir,
      env: body.env,
      stdin: body.stdin,
      timeoutMs: body.timeout_seconds * 1000,
    });
    return c.json({
      exit_code: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      duration_ms: result.durationMs,
    });
  });

  app.post("/:id/sleep", async (c) => c.json(await service.sleep(c.req.param("id"))));
  app.post("/:id/stop", async (c) => c.json(await service.stop(c.req.param("id"))));
  app.post("/:id/start", async (c) => c.json(await service.start(c.req.param("id"))));

  app.delete("/:id", async (c) => {
    await service.delete(c.req.param("id"));
    ports.publicPorts.removeInstance(c.req.param("id"));
    return c.body(null, 204);
  });

  // State changes of one instance (Agent37's events endpoint): the basis of its minutes.
  app.get("/:id/events", (c) => {
    const { from, to, fromMs, toMs } = usageWindow(c.req.query("from"), c.req.query("to"));
    const id = c.req.param("id");
    return c.json({ from, to, events: ports.meter.events(c.get("workspaceId"), id, fromMs, toMs) });
  });

  // Public ports: permanent unauthenticated URLs (Agent37 shapes).
  app.get("/:id/public-ports", (c) => {
    return c.json({ data: ports.publicPorts.list(c.req.param("id")).map(showPort) });
  });

  app.post("/:id/public-ports", async (c) => {
    const body = publicPortBody.parse(await c.req.json());
    return c.json(showPort(ports.publicPorts.add(c.req.param("id"), body)), 201);
  });

  app.delete("/:id/public-ports/:port", (c) => {
    const p = Number(c.req.param("port"));
    if (!ports.publicPorts.remove(c.req.param("id"), p)) {
      return c.json({ error: { code: "not_found", message: `Port ${p} is not public` } }, 404);
    }
    return c.json({ port: p, deleted: true });
  });

  // Signed URL: a time-limited link to a preview URL that a browser can open.
  app.post("/:id/signed-url", async (c) => {
    const id = c.req.param("id");
    const body = signedUrlBody.parse(await c.req.json());
    const ttl = Math.min(SIGNED_URL_MAX_TTL, Math.max(SIGNED_URL_MIN_TTL, body.ttl_seconds));
    const expiresAt = new Date(Date.now() + ttl * 1000);
    const token = ports.signer.sign(id, body.port, expiresAt);
    return c.json({
      url: `${ports.hostUrl(`${id}-${body.port}`)}/?${TOKEN_PARAM}=${encodeURIComponent(token)}`,
      port: body.port,
      expires_at: expiresAt.toISOString(),
    });
  });

  return app;
}
