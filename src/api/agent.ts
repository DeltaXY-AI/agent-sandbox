// Agent API, served at {id}.<domain> (SPEC section 3). Weekend 1: non-streaming turns.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { HarnessAdapter } from "../harnesses/types.ts";
import { ApiError, type InstanceService } from "../instances/service.ts";
import { TEMPLATES } from "../templates.ts";

export interface Session {
  id: string;
  created_at: string;
  updated_at: string;
  turns: number;
  active_response_id: string | null;
  usage: { input_tokens: number; output_tokens: number };
  /** The harness's own session id. Internal. */
  harness_session_id?: string;
}

const responseBody = z.object({
  input: z.string().min(1),
  session_id: z.string().optional(),
  model: z.string().optional(),
  stream: z.boolean().default(false),
  metadata: z.record(z.string(), z.string()).optional(),
});

const newId = (prefix: string) => `${prefix}_${randomBytes(8).toString("hex")}`;
const now = () => new Date().toISOString();

function publicSession(s: Session) {
  const copy: Partial<Session> = { ...s };
  delete copy.harness_session_id;
  return copy;
}

export interface AgentDeps {
  instances: InstanceService;
  harnesses: Record<string, HarnessAdapter>;
  defaultModel: string;
}

type Env = { Bindings: { instanceId: string } };

export function agentApp(deps: AgentDeps) {
  /** Sessions per instance. In memory until a store is needed. */
  const sessions = new Map<string, Map<string, Session>>();
  const sessionsOf = (instanceId: string) => {
    let map = sessions.get(instanceId);
    if (!map) sessions.set(instanceId, (map = new Map()));
    return map;
  };

  const app = new Hono<Env>();

  app.use("*", async (c, next) => {
    const instanceId = c.env.instanceId;
    const given = Buffer.from(c.req.header("x-agent-key") ?? "");
    let expected: Buffer | undefined;
    try {
      const key = deps.instances.get(instanceId).agent_key;
      if (key) expected = Buffer.from(key);
    } catch {
      expected = undefined;
    }
    if (!expected || given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return c.json(
        { error: { code: "unauthorized", message: "Missing or invalid X-Agent-Key" } },
        401,
      );
    }
    await next();
  });

  const harnessFor = (instanceId: string): HarnessAdapter => {
    const instance = deps.instances.get(instanceId);
    const harnessName = TEMPLATES[instance.template]?.harness;
    const harness = harnessName ? deps.harnesses[harnessName] : undefined;
    if (!harness) {
      throw new ApiError(
        400,
        "no_agent",
        `Template ${instance.template} has no agent; use exec instead`,
      );
    }
    return harness;
  };

  app.get("/v1/health", async (c) => {
    const instanceId = c.env.instanceId;
    await deps.instances.refresh();
    // A request to a stopped sandbox wakes it (SPEC section 4).
    if (deps.instances.get(instanceId).status === "stopped") await deps.instances.start(instanceId);
    const instance = deps.instances.get(instanceId);
    const harnessName = TEMPLATES[instance.template]?.harness;
    // Weekend 1: the harness is a CLI started per turn, so ready == sandbox running.
    const healthy = instance.status === "running" && Boolean(harnessName);
    return c.json({ healthy, status: instance.status, agent: harnessName ?? null });
  });

  app.post("/v1/responses", async (c) => {
    const instanceId = c.env.instanceId;
    const body = responseBody.parse(await c.req.json());
    if (body.stream) {
      throw new ApiError(400, "stream_not_supported", "Streaming is not implemented yet");
    }
    const harness = harnessFor(instanceId);
    const instance = deps.instances.get(instanceId);
    if (instance.status !== "running" && instance.status !== "stopped") {
      throw new ApiError(409, "instance_not_ready", `Instance is ${instance.status}`);
    }

    const map = sessionsOf(instanceId);
    let session: Session;
    if (body.session_id) {
      const found = map.get(body.session_id);
      if (!found) throw new ApiError(404, "session_not_found", `No session ${body.session_id}`);
      session = found;
    } else {
      session = {
        id: newId("sess"),
        created_at: now(),
        updated_at: now(),
        turns: 0,
        active_response_id: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      };
      map.set(session.id, session);
    }
    if (session.active_response_id) {
      throw new ApiError(
        409,
        "session_busy",
        `Session ${session.id} is running ${session.active_response_id}`,
      );
    }

    const responseId = newId("resp");
    const model = body.model ?? deps.defaultModel;
    const createdAt = now();
    session.active_response_id = responseId;
    try {
      const result = await harness.runTurn((req) => deps.instances.exec(instanceId, req), {
        input: body.input,
        model,
        harnessSessionId: session.harness_session_id,
      });
      if (result.harnessSessionId) session.harness_session_id = result.harnessSessionId;
      session.turns += 1;
      session.usage.input_tokens += result.usage.inputTokens;
      session.usage.output_tokens += result.usage.outputTokens;
      // A failed turn is HTTP 200 with status "failed" (SPEC section 3).
      return c.json({
        id: responseId,
        object: "response",
        status: result.status,
        session_id: session.id,
        agent: harness.agent,
        model,
        created_at: createdAt,
        completed_at: now(),
        output_text: result.outputText,
        tool_calls: result.toolCalls,
        usage: {
          input_tokens: result.usage.inputTokens,
          output_tokens: result.usage.outputTokens,
        },
        error: result.error ?? null,
        metadata: body.metadata ?? {},
      });
    } finally {
      session.active_response_id = null;
      session.updated_at = now();
    }
  });

  app.get("/v1/sessions", (c) =>
    c.json({ data: [...sessionsOf(c.env.instanceId).values()].map(publicSession) }),
  );

  app.get("/v1/sessions/:sessionId", (c) => {
    const session = sessionsOf(c.env.instanceId).get(c.req.param("sessionId"));
    if (!session) throw new ApiError(404, "session_not_found", "No such session");
    return c.json(publicSession(session));
  });

  return app;
}
