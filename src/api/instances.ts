// Sandbox API: /v1/instances (SPEC section 3).
import { Hono } from "hono";
import { z } from "zod";
import type { SandboxSecret } from "../hosts/types.ts";
import type { InstanceService } from "../instances/service.ts";

const createBody = z.object({
  template: z.string().default("base"),
  env: z.record(z.string(), z.string()).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  resources: z
    .object({ cpu: z.number().int().positive().optional(), memory: z.string().optional() })
    .optional(),
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
) {
  const app = new Hono();

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
    return c.json(service.create({ ...body, secrets }), 201);
  });

  app.get("/", async (c) => {
    await service.refresh();
    return c.json({ data: service.list() });
  });

  app.get("/:id", async (c) => {
    service.get(c.req.param("id")); // 404 before asking the host
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

  app.post("/:id/stop", async (c) => c.json(await service.stop(c.req.param("id"))));
  app.post("/:id/start", async (c) => c.json(await service.start(c.req.param("id"))));

  app.delete("/:id", async (c) => {
    await service.delete(c.req.param("id"));
    return c.body(null, 204);
  });

  return app;
}
