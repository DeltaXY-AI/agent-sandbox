// Instances: in-memory state + lifecycle transitions over a HostProvider (SPEC section 4).
//
// Sleep and wake: an instance is idle when no work is in flight (turns, exec, file calls,
// open streams) and nothing touched it for idle_timeout_seconds. sweepIdle() puts idle
// instances to sleep; any request through use() wakes a sleeping one. A stopped instance
// stays off until start() (decision: sleeping wakes itself, stopped does not).
import { randomBytes } from "node:crypto";
import type { ExecRequest, ExecResult, HostProvider, SandboxSecret } from "../hosts/types.ts";
import type { InstanceRecord } from "../store/store.ts";

export type InstanceStatus =
  | "provisioning"
  | "running"
  | "sleeping"
  | "waking"
  | "stopping"
  | "stopped"
  | "starting"
  | "deleting"
  | "failed";

export interface Instance {
  id: string;
  /** Owner. Other workspaces' keys get 404 for this instance. */
  workspace_id: string;
  template: string;
  status: InstanceStatus;
  created_at: string;
  updated_at: string;
  /** Last request, turn, exec or stream activity. */
  last_active_at: string;
  idle_timeout_seconds: number;
  metadata: Record<string, string>;
  /** Agent API base URL for this instance. */
  url: string;
  /** Key for the Agent API (X-Agent-Key). Absent on instances adopted after a restart. */
  agent_key?: string;
  error?: string;
}

export interface CreateInstanceInput {
  workspace_id: string;
  template: string;
  env?: Record<string, string>;
  metadata?: Record<string, string>;
  resources?: { cpu?: number; memory?: string };
  secrets?: SandboxSecret[];
  idle_timeout_seconds?: number;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** SPEC section 4: default 900 s, range 300-86400. */
export const DEFAULT_IDLE_TIMEOUT_SECONDS = 900;
export const MIN_IDLE_TIMEOUT_SECONDS = 300;
export const MAX_IDLE_TIMEOUT_SECONDS = 86_400;

export interface InstanceServiceOptions {
  /** Clock, injectable for tests. */
  now?: () => number;
  /** How long a request waits for a sleeping instance to wake (Agent37: 503 wake_timeout). */
  wakeTimeoutMs?: number;
  /** Durable instance records (owner, agent key, settings). In memory only when absent. */
  records?: {
    saveInstance(r: InstanceRecord): void;
    deleteInstance(id: string): void;
    loadInstances(): InstanceRecord[];
  };
  /** Owner for sandboxes found on the host with no record. */
  defaultWorkspaceId?: string;
  /** Called on every state change (the meter records it). "deleted" when removed. */
  onStateChange?: (instanceId: string, workspaceId: string, state: string) => void;
}

export class InstanceService {
  private readonly instances = new Map<string, Instance>();
  /** Work in flight per instance; an instance with work never goes to sleep. */
  private readonly inFlight = new Map<string, number>();
  /** One wake per instance at a time; concurrent requests share it. */
  private readonly waking = new Map<string, Promise<void>>();
  private readonly host: HostProvider;
  private readonly prefix: string;
  private readonly urlFor: (id: string) => string;
  private readonly clock: () => number;
  private readonly wakeTimeoutMs: number;
  private readonly records: InstanceServiceOptions["records"];
  private readonly defaultWorkspaceId: string;
  private readonly onStateChange: NonNullable<InstanceServiceOptions["onStateChange"]>;

  constructor(
    host: HostProvider,
    prefix: string,
    urlFor: (id: string) => string,
    options: InstanceServiceOptions = {},
  ) {
    this.host = host;
    this.prefix = prefix;
    this.urlFor = urlFor;
    this.clock = options.now ?? Date.now;
    this.wakeTimeoutMs = options.wakeTimeoutMs ?? 3 * 60_000;
    this.records = options.records;
    this.defaultWorkspaceId = options.defaultWorkspaceId ?? "ws_default";
    this.onStateChange = options.onStateChange ?? (() => undefined);
  }

  private iso(): string {
    return new Date(this.clock()).toISOString();
  }

  /**
   * Adopt sandboxes this platform created before a restart. With a stored record the
   * instance comes back whole (owner, template, agent key); records whose sandbox is
   * gone are dropped. A sandbox with no record joins the default workspace, keyless.
   */
  async adoptExisting(): Promise<number> {
    const sandboxes = await this.host.list();
    const records = new Map((this.records?.loadInstances() ?? []).map((r) => [r.id, r]));
    const onHost = new Set(sandboxes.map((s) => s.name));
    for (const id of records.keys()) if (!onHost.has(id)) this.records?.deleteInstance(id);
    let adopted = 0;
    for (const s of sandboxes) {
      if (!s.name.startsWith(this.prefix) || this.instances.has(s.name)) continue;
      const record = records.get(s.name);
      if (record) {
        this.instances.set(s.name, {
          ...record,
          status: s.status === "running" ? "running" : "sleeping",
          updated_at: this.iso(),
          last_active_at: this.iso(),
          url: this.urlFor(s.name),
        });
        this.reportState(s.name);
        adopted++;
        continue;
      }
      this.instances.set(s.name, {
        id: s.name,
        workspace_id: this.defaultWorkspaceId,
        template: "unknown",
        status: s.status === "running" ? "running" : "sleeping",
        created_at: s.createdAt,
        updated_at: this.iso(),
        last_active_at: this.iso(),
        idle_timeout_seconds: DEFAULT_IDLE_TIMEOUT_SECONDS,
        metadata: {},
        url: this.urlFor(s.name),
      });
      this.reportState(s.name);
      adopted++;
    }
    return adopted;
  }

  create(input: CreateInstanceInput): Instance {
    const id = `${this.prefix}${randomBytes(5).toString("hex")}`;
    const instance: Instance = {
      id,
      workspace_id: input.workspace_id,
      template: input.template,
      status: "provisioning",
      created_at: this.iso(),
      updated_at: this.iso(),
      last_active_at: this.iso(),
      idle_timeout_seconds: input.idle_timeout_seconds ?? DEFAULT_IDLE_TIMEOUT_SECONDS,
      metadata: input.metadata ?? {},
      url: this.urlFor(id),
      agent_key: `ak_${randomBytes(24).toString("hex")}`,
    };
    this.instances.set(id, instance);
    this.reportState(id);
    this.records?.saveInstance({
      id,
      workspace_id: instance.workspace_id,
      template: instance.template,
      agent_key: instance.agent_key ?? "",
      idle_timeout_seconds: instance.idle_timeout_seconds,
      metadata: instance.metadata,
      created_at: instance.created_at,
    });
    // Creation takes several seconds; the client polls GET /v1/instances/{id}.
    void this.host
      .createSandbox({
        name: id,
        template: input.template,
        env: input.env,
        secrets: input.secrets,
        cpus: input.resources?.cpu,
        memory: input.resources?.memory,
      })
      .then(
        () => {
          this.touch(id);
          this.setStatus(id, "running");
        },
        (err: unknown) => this.setStatus(id, "failed", String(err)),
      );
    return { ...instance };
  }

  /** All instances, or only one workspace's. */
  list(workspaceId?: string): Instance[] {
    return [...this.instances.values()]
      .filter((i) => workspaceId === undefined || i.workspace_id === workspaceId)
      .map((i) => ({ ...i }));
  }

  /** get() for a caller in a workspace: another workspace's instance is 404, not 403. */
  owned(id: string, workspaceId: string): Instance {
    const instance = this.instances.get(id);
    if (!instance || instance.workspace_id !== workspaceId) {
      throw new ApiError(404, "instance_not_found", `No instance ${id}`);
    }
    return { ...instance };
  }

  /**
   * Re-read the real state from the host. Sandboxes can stop (or vanish) without going
   * through us. Only settled states are corrected; in-flight transitions are left alone.
   * A sandbox stopped behind our back is treated as sleeping, so the next request wakes it.
   */
  async refresh(): Promise<void> {
    const actual = new Map((await this.host.list()).map((s) => [s.name, s.status]));
    for (const instance of this.instances.values()) {
      if (!["running", "sleeping", "stopped"].includes(instance.status)) continue;
      const status = actual.get(instance.id);
      if (status === undefined) {
        this.setStatus(instance.id, "failed", "Sandbox no longer exists on the host");
      } else if (status === "stopped" && instance.status === "running") {
        this.setStatus(instance.id, "sleeping");
      } else if (status === "running" && instance.status !== "running") {
        this.setStatus(instance.id, "running");
      }
    }
  }

  get(id: string): Instance {
    const instance = this.instances.get(id);
    if (!instance) throw new ApiError(404, "instance_not_found", `No instance ${id}`);
    return { ...instance };
  }

  /** Record activity: resets the idle clock. */
  touch(id: string): void {
    const instance = this.instances.get(id);
    if (instance) instance.last_active_at = this.iso();
  }

  /**
   * Mark work in flight (an open stream, a running turn). The instance will not sleep
   * until the returned release is called. Activity is recorded at both ends.
   */
  hold(id: string): () => void {
    this.inFlight.set(id, (this.inFlight.get(id) ?? 0) + 1);
    this.touch(id);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight.set(id, Math.max(0, (this.inFlight.get(id) ?? 1) - 1));
      this.touch(id);
    };
  }

  /**
   * Make sure the instance is running, waking it if it sleeps. Throws 409 for stopped or
   * not-ready instances and 503 wake_timeout if waking takes too long.
   */
  async ensureAwake(id: string): Promise<void> {
    const instance = this.get(id);
    if (instance.status === "running") return;
    if (instance.status === "sleeping" || instance.status === "waking") {
      await this.wake(id);
      return;
    }
    if (instance.status === "stopped") {
      throw new ApiError(409, "instance_stopped", `Instance ${id} is stopped; start it first`);
    }
    throw new ApiError(409, "instance_not_ready", `Instance ${id} is ${instance.status}`);
  }

  /** Run work against an awake instance, holding it awake while the work runs. */
  async use<T>(id: string, work: () => Promise<T>): Promise<T> {
    await this.ensureAwake(id);
    const release = this.hold(id);
    try {
      return await work();
    } finally {
      release();
    }
  }

  /** Where to reach `port` inside an awake instance. Call inside use(). */
  portAddress(id: string, port: number): Promise<{ host: string; port: number }> {
    return this.host.portAddress(id, port);
  }

  forgetPort(id: string, port: number): void {
    this.host.forgetPort(id, port);
  }

  exec(id: string, request: ExecRequest): Promise<ExecResult> {
    return this.use(id, () => this.host.exec(id, request));
  }

  async sleep(id: string): Promise<Instance> {
    const instance = this.requireStatus(id, ["running", "sleeping"]);
    if (instance.status === "sleeping") return this.get(id);
    if ((this.inFlight.get(id) ?? 0) > 0) {
      throw new ApiError(409, "instance_busy", `Instance ${id} has work in flight`);
    }
    this.setStatus(id, "stopping");
    await this.transition(id, () => this.host.sleep(id), "sleeping");
    return this.get(id);
  }

  /** Put every idle instance to sleep. Called on a timer by the server. */
  async sweepIdle(): Promise<string[]> {
    const slept: string[] = [];
    for (const instance of this.instances.values()) {
      if (instance.status !== "running" || (this.inFlight.get(instance.id) ?? 0) > 0) continue;
      const idleMs = this.clock() - Date.parse(instance.last_active_at);
      if (idleMs < instance.idle_timeout_seconds * 1000) continue;
      try {
        await this.sleep(instance.id);
        slept.push(instance.id);
      } catch (err) {
        console.error(`idle sleep of ${instance.id} failed: ${String(err)}`);
      }
    }
    return slept;
  }

  /** Start sweepIdle on an interval. Returns a stop function. */
  startIdleTimer(intervalMs = 30_000): () => void {
    let running = false;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      void this.sweepIdle()
        .then((slept) => {
          for (const id of slept) console.log(`${id} idle, now sleeping`);
        })
        .finally(() => (running = false));
    }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  private wake(id: string): Promise<void> {
    let pending = this.waking.get(id);
    if (!pending) {
      this.setStatus(id, "waking");
      pending = this.transition(id, () => this.host.wake(id), "running").finally(() => {
        this.waking.delete(id);
        this.touch(id);
      });
      this.waking.set(id, pending);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new ApiError(503, "wake_timeout", `Instance ${id} did not wake in time`)),
        this.wakeTimeoutMs,
      );
    });
    return Promise.race([pending, timeout]).finally(() => clearTimeout(timer));
  }

  async stop(id: string): Promise<Instance> {
    const instance = this.requireStatus(id, ["running", "sleeping", "stopped"]);
    if (instance.status === "stopped") return this.get(id);
    if (instance.status === "sleeping") {
      // Already off on the host; only the intent changes (no wake on request).
      this.setStatus(id, "stopped");
      return this.get(id);
    }
    this.setStatus(id, "stopping");
    await this.transition(id, () => this.host.stop(id), "stopped");
    return this.get(id);
  }

  async start(id: string): Promise<Instance> {
    const instance = this.requireStatus(id, ["running", "sleeping", "stopped"]);
    if (instance.status === "running") return this.get(id);
    if (instance.status === "sleeping") {
      await this.wake(id);
      return this.get(id);
    }
    this.setStatus(id, "starting");
    await this.transition(id, () => this.host.start(id), "running");
    this.touch(id);
    return this.get(id);
  }

  async delete(id: string): Promise<void> {
    const instance = this.get(id);
    if (instance.status === "provisioning" || instance.status === "deleting") {
      throw new ApiError(409, "instance_busy", `Instance ${id} is ${instance.status}`);
    }
    this.setStatus(id, "deleting");
    try {
      await this.host.delete(id);
    } catch (err) {
      // A failed instance may have no sandbox behind it; only keep it if one still exists.
      const stillThere = (await this.host.list()).some((s) => s.name === id);
      if (stillThere) {
        this.setStatus(id, "failed", String(err));
        throw err;
      }
    }
    this.onStateChange(id, instance.workspace_id, "deleted");
    this.instances.delete(id);
    this.inFlight.delete(id);
    this.records?.deleteInstance(id);
  }

  private async transition(id: string, action: () => Promise<void>, next: InstanceStatus) {
    try {
      await action();
      this.setStatus(id, next);
    } catch (err) {
      this.setStatus(id, "failed", String(err));
      throw err;
    }
  }

  private requireStatus(id: string, allowed: InstanceStatus[]): Instance {
    const instance = this.get(id);
    if (!allowed.includes(instance.status)) {
      throw new ApiError(
        409,
        "invalid_state",
        `Instance ${id} is ${instance.status}; needs ${allowed.join(" or ")}`,
      );
    }
    return instance;
  }

  private reportState(id: string) {
    const instance = this.instances.get(id);
    if (instance) this.onStateChange(id, instance.workspace_id, instance.status);
  }

  private setStatus(id: string, status: InstanceStatus, error?: string) {
    const instance = this.instances.get(id);
    if (!instance) return;
    instance.status = status;
    this.onStateChange(id, instance.workspace_id, status);
    instance.updated_at = this.iso();
    if (error) instance.error = error;
    else delete instance.error;
  }
}
