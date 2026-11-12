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
import { InstanceService, type InstanceServiceOptions } from "../src/instances/service.ts";
import { Store } from "../src/store/store.ts";

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
  /** Where portAddress points: a test HTTP server standing in for a port inside the sandbox. */
  upstreamPort = 1;
  async portAddress() {
    return { host: "127.0.0.1", port: this.upstreamPort };
  }
  forgetPort() {}
  wakeDelayMs = 0;
  wakes = 0;
  async sleep(name: string) {
    this.sandboxes.set(name, "stopped");
  }
  async wake(name: string) {
    this.wakes++;
    if (this.wakeDelayMs) await new Promise((r) => setTimeout(r, this.wakeDelayMs));
    this.sandboxes.set(name, "running");
  }
  async delete(name: string) {
    this.sandboxes.delete(name);
  }
}

function setup(options: InstanceServiceOptions = {}) {
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
  const store = new Store(":memory:");
  store.bootstrapDefault("k");
  const instances = new InstanceService(host, "sb-", (id) => `http://${id}.localhost`, {
    records: store,
    ...options,
  });
  const app = buildApp({
    store,
    adminKey: "admin",
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
    store,
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
  it("treats a sandbox stopped behind our back as sleeping, and health wakes it", async () => {
    const { app, host } = setup();
    const inst = await createRunning(app);
    host.sandboxes.set(inst.id, "stopped");

    const listed = (await (
      await app.request(`/v1/instances/${inst.id}`, { headers: { authorization: "Bearer k" } })
    ).json()) as { status: string };
    expect(listed.status).toBe("sleeping");

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

describe("Sleep and wake", () => {
  const api = (path: string, init: RequestInit = {}) => ({
    ...init,
    headers: { authorization: "Bearer k", "content-type": "application/json" },
  });
  const status = async (app: ReturnType<typeof setup>["app"], id: string) =>
    ((await (await app.request(`/v1/instances/${id}`, api(""))).json()) as { status: string })
      .status;

  it("sleeps an instance after idle_timeout_seconds with no activity, not before", async () => {
    let t = 1_000_000;
    const ctx = setup({ now: () => t });
    const inst = await createRunning(ctx.app);
    t += 899_000;
    expect(await ctx.instances.sweepIdle()).toEqual([]);
    t += 2_000;
    expect(await ctx.instances.sweepIdle()).toEqual([inst.id]);
    expect(await status(ctx.app, inst.id)).toBe("sleeping");
    expect(ctx.host.sandboxes.get(inst.id)).toBe("stopped");
  });

  it("any agent request resets the idle clock", async () => {
    let t = 0;
    const ctx = setup({ now: () => t });
    const inst = await createRunning(ctx.app);
    t += 800_000;
    await ctx.app.fetch(agentReq(inst.id, inst.agent_key, "/v1/sessions"));
    t += 800_000;
    expect(await ctx.instances.sweepIdle()).toEqual([]);
  });

  it("never sleeps while a turn runs or a stream is open", async () => {
    let t = 0;
    const ctx = setup({ now: () => t });
    const inst = await createRunning(ctx.app);
    ctx.blockNext();
    const live = await ctx.app.fetch(
      agentReq(inst.id, inst.agent_key, "/v1/responses", { input: "x", stream: true }),
    );
    t += 10 * 3_600_000;
    expect(await ctx.instances.sweepIdle()).toEqual([]);
    ctx.release();
    await live.text(); // stream ends with the turn
    t += 901_000;
    expect(await ctx.instances.sweepIdle()).toEqual([inst.id]);
  });

  it("a request to a sleeping instance wakes it once, even when requests race", async () => {
    const ctx = setup();
    const inst = await createRunning(ctx.app);
    await ctx.app.request(`/v1/instances/${inst.id}/sleep`, api("", { method: "POST" }));
    ctx.host.wakeDelayMs = 20;
    const [a, b] = await Promise.all([
      ctx.app.fetch(agentReq(inst.id, inst.agent_key, "/v1/responses", { input: "a" })),
      ctx.app.request(
        `/v1/instances/${inst.id}/exec`,
        api("", { method: "POST", body: JSON.stringify({ command: "ls" }) }),
      ),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(ctx.host.wakes).toBe(1);
    expect(await status(ctx.app, inst.id)).toBe("running");
  });

  it("returns 503 wake_timeout when waking takes too long", async () => {
    const ctx = setup({ wakeTimeoutMs: 10 });
    const inst = await createRunning(ctx.app);
    await ctx.instances.sleep(inst.id);
    ctx.host.wakeDelayMs = 50;
    const res = await ctx.app.fetch(agentReq(inst.id, inst.agent_key, "/v1/sessions"));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "wake_timeout" } });
  });

  it("a stopped instance stays off until /start", async () => {
    const ctx = setup();
    const inst = await createRunning(ctx.app);
    await ctx.app.request(`/v1/instances/${inst.id}/stop`, api("", { method: "POST" }));
    const turn = await ctx.app.fetch(
      agentReq(inst.id, inst.agent_key, "/v1/responses", { input: "x" }),
    );
    expect(turn.status).toBe(409);
    expect(await turn.json()).toMatchObject({ error: { code: "instance_stopped" } });
    const health = await (
      await ctx.app.fetch(agentReq(inst.id, inst.agent_key, "/v1/health"))
    ).json();
    expect(health).toMatchObject({ healthy: false, status: "stopped" });
    const exec = await ctx.app.request(
      `/v1/instances/${inst.id}/exec`,
      api("", { method: "POST", body: JSON.stringify({ command: "ls" }) }),
    );
    expect(exec.status).toBe(409);
    await ctx.app.request(`/v1/instances/${inst.id}/start`, api("", { method: "POST" }));
    expect(await status(ctx.app, inst.id)).toBe("running");
  });

  it("POST /sleep refuses while a turn runs, and idle_timeout_seconds is validated", async () => {
    const ctx = setup();
    const inst = await createRunning(ctx.app);
    ctx.blockNext();
    const running = ctx.app.fetch(
      agentReq(inst.id, inst.agent_key, "/v1/responses", { input: "x" }),
    );
    await new Promise((r) => setTimeout(r, 0));
    const busy = await ctx.app.request(
      `/v1/instances/${inst.id}/sleep`,
      api("", { method: "POST" }),
    );
    expect(busy.status).toBe(409);
    ctx.release();
    await running;

    const tooShort = await ctx.app.request(
      "/v1/instances",
      api("", {
        method: "POST",
        body: JSON.stringify({ template: "fx", idle_timeout_seconds: 60 }),
      }),
    );
    expect(tooShort.status).toBe(400);
    const created = (await (
      await ctx.app.request("/v1/instances", api("", { method: "POST", body: "{}" }))
    ).json()) as { idle_timeout_seconds: number; last_active_at: string };
    expect(created.idle_timeout_seconds).toBe(900);
    expect(created.last_active_at).toMatch(/^\d{4}-/);
  });
});

describe("Workspaces and keys", () => {
  const json = (key: string, method = "GET", body?: unknown) => ({
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  /** Workspace B through the admin API; returns its first key. */
  async function workspaceB(app: ReturnType<typeof setup>["app"]) {
    const res = await app.request("/v1/admin/workspaces", json("admin", "POST", { name: "b" }));
    expect(res.status).toBe(201);
    return (await res.json()) as {
      workspace: { id: string };
      api_key: { id: string; key: string; prefix: string };
    };
  }

  it("admin API: only the admin key, creates workspaces with a key shown once", async () => {
    const { app } = setup();
    expect((await app.request("/v1/admin/workspaces", json("k"))).status).toBe(401);
    expect((await app.request("/v1/admin/workspaces")).status).toBe(401);
    const b = await workspaceB(app);
    expect(b.api_key.key).toMatch(/^sk_live_/);
    const detail = (await (
      await app.request(`/v1/admin/workspaces/${b.workspace.id}`, json("admin"))
    ).json()) as { name: string; api_keys: Record<string, unknown>[] };
    expect(detail.name).toBe("b");
    expect(detail.api_keys).toHaveLength(1);
    expect(detail.api_keys[0]).not.toHaveProperty("key");
    const list = (await (await app.request("/v1/admin/workspaces", json("admin"))).json()) as {
      data: { id: string }[];
    };
    expect(list.data.map((w) => w.id)).toEqual(["ws_default", b.workspace.id]);
  });

  it("a key from another workspace gets 404 on this workspace's instances (step 9)", async () => {
    const ctx = setup();
    const a = await createRunning(ctx.app); // default workspace, key "k"
    const b = await workspaceB(ctx.app);
    const bKey = b.api_key.key;

    expect(
      (
        (await (await ctx.app.request("/v1/instances", json(bKey))).json()) as {
          data: unknown[];
        }
      ).data,
    ).toEqual([]);
    for (const [path, method, body] of [
      [`/v1/instances/${a.id}`, "GET", undefined],
      [`/v1/instances/${a.id}/exec`, "POST", { command: "cat /home/agent/hello.py" }],
      [`/v1/instances/${a.id}/stop`, "POST", undefined],
      [`/v1/instances/${a.id}/public-ports`, "POST", { port: 8080 }],
      [`/v1/instances/${a.id}/signed-url`, "POST", { port: 8080 }],
    ] as const) {
      const res = await ctx.app.request(path, json(bKey, method, body));
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    const del = await ctx.app.request(`/v1/instances/${a.id}`, json(bKey, "DELETE"));
    expect(del.status).toBe(404);
    // Preview URLs too, even before checking a credential of the right workspace.
    const preview = await ctx.app.fetch(
      new Request(`http://${a.id}-8080.localhost/`, {
        headers: { host: `${a.id}-8080.localhost`, authorization: `Bearer ${bKey}` },
      }),
    );
    expect(preview.status).toBe(404);

    // B's own instance works with B's key and is invisible to the default workspace.
    const mine = (await (
      await ctx.app.request("/v1/instances", json(bKey, "POST", { template: "fx" }))
    ).json()) as { id: string; workspace_id: string };
    expect(mine.workspace_id).toBe(b.workspace.id);
    expect((await ctx.app.request(`/v1/instances/${mine.id}`, json("k"))).status).toBe(404);
  });

  it("a revoked key stops working at once", async () => {
    const { app } = setup();
    const b = await workspaceB(app);
    expect((await app.request("/v1/instances", json(b.api_key.key))).status).toBe(200);
    const revoked = await app.request(
      `/v1/admin/workspaces/${b.workspace.id}/keys/${b.api_key.id}`,
      json("admin", "DELETE"),
    );
    expect(await revoked.json()).toEqual({ id: b.api_key.id, revoked: true });
    expect((await app.request("/v1/instances", json(b.api_key.key))).status).toBe(401);
  });

  it("after a restart, instances come back with their owner and agent key", async () => {
    const ctx = setup();
    const inst = await createRunning(ctx.app);
    const again = new InstanceService(ctx.host, "sb-", (id) => `http://${id}.localhost`, {
      records: ctx.store,
    });
    expect(await again.adoptExisting()).toBe(1);
    expect(again.get(inst.id)).toMatchObject({
      workspace_id: "ws_default",
      template: "fx",
      agent_key: inst.agent_key,
    });
  });
});

describe("Preview URLs and public ports", () => {
  const auth = { authorization: "Bearer k", "content-type": "application/json" };
  const at = (label: string, path = "/", headers: Record<string, string> = {}) =>
    new Request(`http://${label}.localhost${path}`, {
      headers: { host: `${label}.localhost`, ...headers },
    });

  /** A real HTTP server standing in for a web server the agent started in the sandbox. */
  async function upstream() {
    const { createServer } = await import("node:http");
    const seen: { url: string; headers: Record<string, unknown> }[] = [];
    const server = createServer((req, res) => {
      seen.push({ url: req.url ?? "", headers: req.headers });
      res.setHeader("content-type", "text/plain");
      res.end(`hello from 8080 ${req.url}`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    return { port, seen, close: () => new Promise((r) => server.close(r)) };
  }

  it("preview URL needs a credential and never forwards ours", async () => {
    const ctx = setup();
    const up = await upstream();
    ctx.host.upstreamPort = up.port;
    const inst = await createRunning(ctx.app);
    const label = `${inst.id}-8080`;

    expect((await ctx.app.fetch(at(label))).status).toBe(401);

    const viaKey = await ctx.app.fetch(at(label, "/a?x=1", { authorization: "Bearer k" }));
    expect(viaKey.status).toBe(200);
    expect(await viaKey.text()).toBe("hello from 8080 /a?x=1");
    expect(up.seen.at(-1)?.headers.authorization).toBeUndefined();
    expect(up.seen.at(-1)?.headers["x-forwarded-host"]).toBe(`${label}.localhost`);

    const viaAgentKey = await ctx.app.fetch(at(label, "/", { "x-agent-key": inst.agent_key }));
    expect(viaAgentKey.status).toBe(200);
    expect(up.seen.at(-1)?.headers["x-agent-key"]).toBeUndefined();

    const other = await ctx.app.fetch(at("sb-0000000000-8080", "/", { authorization: "Bearer k" }));
    expect(other.status).toBe(404);
    await up.close();
  });

  it("signed URL opens the preview, becomes a cookie, and only for its port", async () => {
    const ctx = setup();
    const up = await upstream();
    ctx.host.upstreamPort = up.port;
    const inst = await createRunning(ctx.app);
    const signed = (await (
      await ctx.app.request(`/v1/instances/${inst.id}/signed-url`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ port: 8080, ttl_seconds: 5 }),
      })
    ).json()) as { url: string; expires_at: string };
    const url = new URL(signed.url);
    expect(url.hostname).toBe(`${inst.id}-8080.localhost`);
    // ttl below the minimum is clamped to 60 s.
    expect(Date.parse(signed.expires_at) - Date.now()).toBeGreaterThan(50_000);

    const first = await ctx.app.fetch(at(`${inst.id}-8080`, `${url.pathname}${url.search}`));
    expect(first.status).toBe(200);
    expect(up.seen.at(-1)?.url).toBe("/"); // token stripped before the sandbox sees it
    const cookie = first.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^as_token=.+; Max-Age=\d+; Path=\/; HttpOnly/);

    const again = await ctx.app.fetch(
      at(`${inst.id}-8080`, "/next", { cookie: cookie.split(";")[0] ?? "" }),
    );
    expect(again.status).toBe(200);
    expect(up.seen.at(-1)?.headers.cookie).toBeUndefined();

    const wrongPort = await ctx.app.fetch(at(`${inst.id}-9090`, `/${url.search}`));
    expect(wrongPort.status).toBe(401);
    await up.close();
  });

  it("public ports need no credential, and can be listed and removed", async () => {
    const ctx = setup();
    const up = await upstream();
    ctx.host.upstreamPort = up.port;
    const created = (await (
      await ctx.app.request("/v1/instances", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ template: "fx", public_ports: [{ port: 8080, prefix: "hooks" }] }),
      })
    ).json()) as { id: string; public_ports: { url: string }[] };
    await new Promise((r) => setTimeout(r, 0));
    expect(created.public_ports[0]?.url).toBe(`http://hooks-${created.id}.localhost`);

    const res = await ctx.app.fetch(at(`hooks-${created.id}`, "/webhook"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello from 8080 /webhook");

    const added = (await (
      await ctx.app.request(`/v1/instances/${created.id}/public-ports`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ port: 9000 }),
      })
    ).json()) as { url: string };
    expect(new URL(added.url).hostname).toMatch(/^[a-z0-9]{20}\.localhost$/);
    const dup = await ctx.app.request(`/v1/instances/${created.id}/public-ports`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ port: 9000 }),
    });
    expect(dup.status).toBe(409);

    const list = (await (
      await ctx.app.request(`/v1/instances/${created.id}/public-ports`, { headers: auth })
    ).json()) as { data: { port: number }[] };
    expect(list.data.map((p) => p.port)).toEqual([8080, 9000]);

    const del = await ctx.app.request(`/v1/instances/${created.id}/public-ports/8080`, {
      method: "DELETE",
      headers: auth,
    });
    expect(await del.json()).toEqual({ port: 8080, deleted: true });
    expect((await ctx.app.fetch(at(`hooks-${created.id}`))).status).toBe(404);
    await up.close();
  });

  it("wakes a sleeping instance, 503 when stopped, 502 when nothing listens", async () => {
    const ctx = setup();
    const up = await upstream();
    ctx.host.upstreamPort = up.port;
    const inst = await createRunning(ctx.app);
    const key = { authorization: "Bearer k" };

    await ctx.instances.sleep(inst.id);
    const woke = await ctx.app.fetch(at(`${inst.id}-8080`, "/", key));
    expect(woke.status).toBe(200);
    expect(ctx.host.wakes).toBe(1);

    await ctx.instances.stop(inst.id);
    const stopped = await ctx.app.fetch(at(`${inst.id}-8080`, "/", key));
    expect(stopped.status).toBe(503);
    expect(await stopped.json()).toMatchObject({ error: { code: "unavailable" } });

    await ctx.instances.start(inst.id);
    await up.close();
    const nothing = await ctx.app.fetch(at(`${inst.id}-8080`, "/", key));
    expect(nothing.status).toBe(502);
    expect(await nothing.json()).toMatchObject({ error: { code: "upstream_unavailable" } });
  });
});
