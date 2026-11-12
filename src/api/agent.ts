// Agent API, served at {id}.<domain> (SPEC section 3).
// A turn runs independently of the HTTP request that started it: it fills a replay
// buffer, and the streamed reply, the non-streamed reply and reattach all read from it.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { ResponseStore } from "../events/buffer.ts";
import type { Meter } from "../meter/meter.ts";
import { parseLastEventId, sseResponse } from "../events/sse.ts";
import type { HarnessAdapter, TurnResult } from "../harnesses/types.ts";
import { ApiError, type InstanceService } from "../instances/service.ts";
import { TEMPLATES } from "../templates.ts";
import { filesRoutes } from "./files.ts";

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
  /** Records each finished turn's tokens. */
  meter: Meter;
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
  /** Replay buffers per instance. */
  const responses = new Map<string, ResponseStore>();
  const responsesOf = (instanceId: string) => {
    let store = responses.get(instanceId);
    if (!store) responses.set(instanceId, (store = new ResponseStore()));
    return store;
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
    // Any authenticated request wakes a sleeping instance and counts as activity
    // (SPEC section 4). Stopped instances stay off; routes that need them running say so.
    const status = deps.instances.get(instanceId).status;
    if (status === "sleeping" || status === "waking") await deps.instances.ensureAwake(instanceId);
    deps.instances.touch(instanceId);
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
    // Refresh can find the sandbox stopped behind our back (now sleeping): wake it too.
    // A stopped instance only reports itself.
    if (deps.instances.get(instanceId).status === "sleeping") {
      await deps.instances.ensureAwake(instanceId);
    }
    const instance = deps.instances.get(instanceId);
    const harnessName = TEMPLATES[instance.template]?.harness;
    // Weekend 1: the harness is a CLI started per turn, so ready == sandbox running.
    const healthy = instance.status === "running" && Boolean(harnessName);
    return c.json({ healthy, status: instance.status, agent: harnessName ?? null });
  });

  app.post("/v1/responses", async (c) => {
    const instanceId = c.env.instanceId;
    const body = responseBody.parse(await c.req.json());
    const harness = harnessFor(instanceId);
    await deps.instances.ensureAwake(instanceId);

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
    // Captured now: the instance may be deleted before the turn ends.
    const workspaceId = deps.instances.get(instanceId).workspace_id;
    session.active_response_id = responseId;
    const buffer = responsesOf(instanceId).create(responseId, session.id);
    buffer.push({ event: "response.created", data: { id: responseId, session_id: session.id } });

    // Runs to the end even if the client disconnects; reattach reads the buffer.
    const turn = (async (): Promise<TurnResult> => {
      // The instance must not sleep while a turn runs.
      const release = deps.instances.hold(instanceId);
      try {
        const result = await harness.runTurn(
          (req) => deps.instances.exec(instanceId, req),
          { input: body.input, model, harnessSessionId: session.harness_session_id },
          (event) => {
            if (!buffer.done) buffer.push(event);
          },
        );
        if (result.harnessSessionId) session.harness_session_id = result.harnessSessionId;
        session.turns += 1;
        session.usage.input_tokens += result.usage.inputTokens;
        session.usage.output_tokens += result.usage.outputTokens;
        return result;
      } catch (err) {
        console.error(`turn ${responseId} failed:`, err);
        return {
          status: "failed",
          outputText: "",
          usage: { inputTokens: 0, outputTokens: 0 },
          toolCalls: [],
          error: {
            code: "harness_error",
            message: err instanceof Error ? err.message : String(err),
          },
        };
      } finally {
        release();
        session.active_response_id = null;
        session.updated_at = now();
      }
    })().then((result) => {
      deps.meter.recordTurn({
        instance_id: instanceId,
        workspace_id: workspaceId,
        response_id: responseId,
        model,
        input_tokens: result.usage.inputTokens,
        output_tokens: result.usage.outputTokens,
      });
      const usage = {
        input_tokens: result.usage.inputTokens,
        output_tokens: result.usage.outputTokens,
      };
      buffer.push(
        result.status === "completed"
          ? {
              event: "response.completed",
              data: {
                output_text: result.outputText,
                usage,
                context: null,
                reasoning_effort: null,
              },
            }
          : {
              event: "response.failed",
              data: { error: result.error ?? { code: "harness_error", message: "Turn failed" } },
            },
      );
      return result;
    });

    // An open stream keeps the instance awake while it is connected.
    if (body.stream) return sseResponse(buffer, 0, deps.instances.hold(instanceId));

    const result = await turn;
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
  });

  // Reattach: replay after Last-Event-ID (or from the start), then follow the live turn.
  app.get("/v1/responses/:responseId/stream", (c) => {
    const buffer = responsesOf(c.env.instanceId).get(c.req.param("responseId"));
    if (!buffer) {
      throw new ApiError(404, "response_not_found", "No such response, or its record expired");
    }
    return sseResponse(
      buffer,
      parseLastEventId(c.req.header("last-event-id")),
      deps.instances.hold(c.env.instanceId),
    );
  });

  app.route("/v1/files", filesRoutes(deps.instances));

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
