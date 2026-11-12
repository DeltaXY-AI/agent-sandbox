import { describe, expect, it } from "vitest";
import { agentHostId, buildApp } from "../src/app.ts";
import type { HarnessAdapter, TurnInput } from "../src/harnesses/types.ts";
import type {
  ExecRequest,
  HostProvider,
  HostSandbox,
  HostStatus,
  SandboxSpec,
} from "../src/hosts/types.ts";
import { InstanceService } from "../src/instances/service.ts";

class FakeHost implements HostProvider {
  readonly name = "fake";
  readonly sandboxes = new Map<string, HostStatus>();
  async createSandbox(spec: SandboxSpec): Promise<HostSandbox> {
    this.sandboxes.set(spec.name, "running");
    return { name: spec.name, hostId: spec.name, status: "running", createdAt: "" };
  }
  async list(): Promise<HostSandbox[]> {
    return [...this.sandboxes].map(([name, status]) => ({
      name,
      hostId: name,
      status,
      createdAt: "",
    }));
  }
  async exec(name: string, req: ExecRequest) {
    this.sandboxes.set(name, "running"); // like sbx: exec starts a stopped sandbox
    return { exitCode: 0, stdout: req.cmd.join(" "), stderr: "", durationMs: 1 };
  }
  async stop(name: string) {
    this.sandboxes.set(name, "stopped");
  }
  async start(name: string) {
    this.sandboxes.set(name, "running");
  }
  async delete(name: string) {
    this.sandboxes.delete(name);
  }
}

function setup() {
  const seen: TurnInput[] = [];
  let release: () => void = () => undefined;
  let block = false;
  let throwNext = false;
  const harness: HarnessAdapter = {
    agent: "fx",
    secrets: [],
    async runTurn(_exec, input, onEvent) {
      seen.push(input);
      onEvent?.({ event: "response.tool_call.started", data: { tool: "shell", label: "ls" } });
      if (block) await new Promise<void>((r) => (release = r));
      if (throwNext) {
        throwNext = false;
        throw new Error("sbx exec failed (exit 125)");
      }
      onEvent?.({ event: "response.tool_call.completed", data: { tool: "shell" } });
      onEvent?.({ event: "response.output_text.delta", data: { text: `echo: ${input.input}` } });
      return {
        status: "completed",
        outputText: `echo: ${input.input}`,
        harnessSessionId: `h${seen.length}`,
        usage: { inputTokens: 10, outputTokens: 2 },
        toolCalls: [],
      };
    },
  };
  const host = new FakeHost();
  const instances = new InstanceService(host, "sb-", (id) => `http://${id}.localhost`);
  const app = buildApp({
    apiKey: "k",
    instances,
    templates: ["base", "fx"],
    harnesses: { fx: harness },
    defaultModel: "default-model",
    sandboxPrefix: "sb-",
    secretsForTemplate: () => [],
  });
  return {
    app,
    host,
    instances,
    seen,
    blockNext: () => (block = true),
    throwNext: () => (throwNext = true),
    release: () => {
      block = false;
      release();
    },
  };
}

async function createRunning(app: ReturnType<typeof setup>["app"], template = "fx") {
  const res = await app.request("/v1/instances", {
    method: "POST",
    headers: { authorization: "Bearer k", "content-type": "application/json" },
    body: JSON.stringify({ template }),
  });
  const inst = (await res.json()) as { id: string; agent_key: string };
  await new Promise((r) => setTimeout(r, 0)); // fake create resolves on next tick
  return inst;
}

function agentReq(id: string, key: string, path: string, body?: unknown) {
  return new Request(`http://${id}.localhost:3000${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      host: `${id}.localhost:3000`,
      "x-agent-key": key,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe("agentHostId", () => {
  it("extracts the instance id from the host", () => {
    expect(agentHostId("sb-abc.localhost:3000", "sb-")).toBe("sb-abc");
    expect(agentHostId("localhost:3000", "sb-")).toBeUndefined();
    expect(agentHostId("api.localhost", "sb-")).toBeUndefined();
  });
});

describe("Agent API", () => {
  it("rejects a wrong agent key", async () => {
    const { app } = setup();
    const inst = await createRunning(app);
    const res = await app.fetch(agentReq(inst.id, "wrong", "/v1/health"));
    expect(res.status).toBe(401);
  });

  it("runs turns and continues the session with the harness session id", async () => {
    const { app, seen } = setup();
    const inst = await createRunning(app);
    const health = await (await app.fetch(agentReq(inst.id, inst.agent_key, "/v1/health"))).json();
    expect(health).toMatchObject({ healthy: true, agent: "fx" });

    const first = (await (
      await app.fetch(agentReq(inst.id, inst.agent_key, "/v1/responses", { input: "one" }))
    ).json()) as { session_id: string; status: string; output_text: string; model: string };
    expect(first).toMatchObject({
      status: "completed",
      output_text: "echo: one",
      model: "default-model",
    });

    await app.fetch(
      agentReq(inst.id, inst.agent_key, "/v1/responses", {
        input: "two",
        session_id: first.session_id,
      }),
    );
    expect(seen[1]).toMatchObject({ input: "two", harnessSessionId: "h1" });

    const session = await (
      await app.fetch(agentReq(inst.id, inst.agent_key, `/v1/sessions/${first.session_id}`))
    ).json();
    expect(session).toMatchObject({ turns: 2, usage: { input_tokens: 20, output_tokens: 4 } });
    expect(session).not.toHaveProperty("harness_session_id");
  });

  it("returns 409 session_busy for a second turn on a running session", async () => {
    const ctx = setup();
    const inst = await createRunning(ctx.app);
    const first = (await (
      await ctx.app.fetch(agentReq(inst.id, inst.agent_key, "/v1/responses", { input: "a" }))
    ).json()) as { session_id: string };
    ctx.blockNext();
    const running = ctx.app.fetch(
      agentReq(inst.id, inst.agent_key, "/v1/responses", {
        input: "b",
        session_id: first.session_id,
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    const busy = await ctx.app.fetch(
      agentReq(inst.id, inst.agent_key, "/v1/responses", {
        input: "c",
        session_id: first.session_id,
      }),
    );
    expect(busy.status).toBe(409);
    expect(((await busy.json()) as { error: { code: string } }).error.code).toBe("session_busy");
    ctx.release();
    expect((await running).status).toBe(200);
  });

  it("refuses agent turns on a template without a harness", async () => {
    const { app } = setup();
    const inst = await createRunning(app, "base");
    const res = await app.fetch(agentReq(inst.id, inst.agent_key, "/v1/responses", { input: "x" }));
    expect(res.status).toBe(400);
  });
});

/** Event names and ids from an SSE body. */
async function sseFrames(res: Response) {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((f) => f.startsWith("id: "))
    .map((f) => {
      const [, id = "", event = "", data = ""] =
        /^id: (\d+)\nevent: (\S+)\ndata: (.*)$/s.exec(f) ?? [];
      return { id: Number(id), event, data: JSON.parse(data) as Record<string, unknown> };
    });
}

describe("Streaming", () => {
  it("streams the turn as SSE: created, harness events, completed", async () => {
    const { app } = setup();
    const inst = await createRunning(app);
    const res = await app.fetch(
      agentReq(inst.id, inst.agent_key, "/v1/responses", { input: "hi", stream: true }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const frames = await sseFrames(res);
    expect(frames.map((f) => f.event)).toEqual([
      "response.created",
      "response.tool_call.started",
      "response.tool_call.completed",
      "response.output_text.delta",
      "response.completed",
    ]);
    expect(frames.map((f) => f.id)).toEqual([1, 2, 3, 4, 5]);
    expect(frames[4]?.data).toMatchObject({
      output_text: "echo: hi",
      usage: { input_tokens: 10, output_tokens: 2 },
    });
  });

  it("reattach replays after Last-Event-ID and follows the live turn", async () => {
    const ctx = setup();
    const inst = await createRunning(ctx.app);
    ctx.blockNext();
    const live = await ctx.app.fetch(
      agentReq(inst.id, inst.agent_key, "/v1/responses", { input: "x", stream: true }),
    );
    // The first client goes away; the turn keeps running.
    await live.body?.cancel();
    const responseId = (
      (await ctx.app.fetch(agentReq(inst.id, inst.agent_key, "/v1/sessions"))).json() as Promise<{
        data: { active_response_id: string }[];
      }>
    ).then((s) => s.data[0]?.active_response_id);
    const id = await responseId;
    expect(id).toMatch(/^resp_/);
    const req = agentReq(inst.id, inst.agent_key, `/v1/responses/${id}/stream`);
    req.headers.set("last-event-id", "1");
    const reattached = ctx.app.fetch(req);
    await new Promise((r) => setTimeout(r, 0));
    ctx.release();
    const frames = await sseFrames(await reattached);
    expect(frames.map((f) => f.id)).toEqual([2, 3, 4, 5]);
    expect(frames.at(-1)?.event).toBe("response.completed");
  });

  it("returns 404 response_not_found for an unknown response", async () => {
    const { app } = setup();
    const inst = await createRunning(app);
    const res = await app.fetch(agentReq(inst.id, inst.agent_key, "/v1/responses/resp_x/stream"));
    expect(res.status).toBe(404);
  });

  it("a harness error ends the stream with response.failed, and is HTTP 200 when not streamed", async () => {
    const ctx = setup();
    const inst = await createRunning(ctx.app);
    ctx.throwNext();
    const frames = await sseFrames(
      await ctx.app.fetch(
        agentReq(inst.id, inst.agent_key, "/v1/responses", { input: "x", stream: true }),
      ),
    );
    expect(frames.at(-1)).toMatchObject({
      event: "response.failed",
      data: { error: { code: "harness_error" } },
    });
    ctx.throwNext();
    const res = await ctx.app.fetch(
      agentReq(inst.id, inst.agent_key, "/v1/responses", { input: "y" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "failed", error: { code: "harness_error" } });
  });
});

describe("status refresh", () => {
  it("shows a sandbox stopped behind our back, and health wakes it", async () => {
    const { app, host } = setup();
    const inst = await createRunning(app);
    host.sandboxes.set(inst.id, "stopped");

    const listed = (await (
      await app.request(`/v1/instances/${inst.id}`, { headers: { authorization: "Bearer k" } })
    ).json()) as { status: string };
    expect(listed.status).toBe("stopped");

    const health = await (await app.fetch(agentReq(inst.id, inst.agent_key, "/v1/health"))).json();
    expect(health).toMatchObject({ healthy: true, status: "running" });
    expect(host.sandboxes.get(inst.id)).toBe("running");
  });

  it("marks an instance failed when its sandbox disappeared", async () => {
    const { app, host } = setup();
    const inst = await createRunning(app);
    host.sandboxes.delete(inst.id);
    const res = (await (
      await app.request(`/v1/instances/${inst.id}`, { headers: { authorization: "Bearer k" } })
    ).json()) as { status: string; error: string };
    expect(res).toMatchObject({ status: "failed", error: "Sandbox no longer exists on the host" });
  });
});
