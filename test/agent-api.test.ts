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
  const harness: HarnessAdapter = {
    agent: "fx",
    secrets: [],
    async runTurn(_exec, input) {
      seen.push(input);
      if (block) await new Promise<void>((r) => (release = r));
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
    release: () => release(),
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
