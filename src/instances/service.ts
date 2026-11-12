// Instances: in-memory state + lifecycle transitions over a HostProvider.
import { randomBytes } from "node:crypto";
import type { ExecRequest, ExecResult, HostProvider, SandboxSecret } from "../hosts/types.ts";

export type InstanceStatus =
  "provisioning" | "running" | "stopping" | "stopped" | "starting" | "deleting" | "failed";

export interface Instance {
  id: string;
  template: string;
  status: InstanceStatus;
  created_at: string;
  updated_at: string;
  metadata: Record<string, string>;
  /** Agent API base URL for this instance. */
  url: string;
  /** Key for the Agent API (X-Agent-Key). Absent on instances adopted after a restart. */
  agent_key?: string;
  error?: string;
}

export interface CreateInstanceInput {
  template: string;
  env?: Record<string, string>;
  metadata?: Record<string, string>;
  resources?: { cpu?: number; memory?: string };
  secrets?: SandboxSecret[];
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

const now = () => new Date().toISOString();

export class InstanceService {
  private readonly instances = new Map<string, Instance>();
  private readonly host: HostProvider;
  private readonly prefix: string;
  private readonly urlFor: (id: string) => string;

  constructor(host: HostProvider, prefix: string, urlFor: (id: string) => string) {
    this.host = host;
    this.prefix = prefix;
    this.urlFor = urlFor;
  }

  /** Adopt sandboxes this platform created before a restart. Template is not recoverable yet. */
  async adoptExisting(): Promise<number> {
    const sandboxes = await this.host.list();
    let adopted = 0;
    for (const s of sandboxes) {
      if (!s.name.startsWith(this.prefix) || this.instances.has(s.name)) continue;
      this.instances.set(s.name, {
        id: s.name,
        template: "unknown",
        status: s.status === "running" ? "running" : "stopped",
        created_at: s.createdAt,
        updated_at: now(),
        metadata: {},
        url: this.urlFor(s.name),
      });
      adopted++;
    }
    return adopted;
  }

  create(input: CreateInstanceInput): Instance {
    const id = `${this.prefix}${randomBytes(5).toString("hex")}`;
    const instance: Instance = {
      id,
      template: input.template,
      status: "provisioning",
      created_at: now(),
      updated_at: now(),
      metadata: input.metadata ?? {},
      url: this.urlFor(id),
      agent_key: `ak_${randomBytes(24).toString("hex")}`,
    };
    this.instances.set(id, instance);
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
        () => this.setStatus(id, "running"),
        (err: unknown) => this.setStatus(id, "failed", String(err)),
      );
    return { ...instance };
  }

  list(): Instance[] {
    return [...this.instances.values()].map((i) => ({ ...i }));
  }

  /**
   * Re-read the real state from the host. Sandboxes can stop (or vanish) without going
   * through us. Only settled states are corrected; in-flight transitions are left alone.
   */
  async refresh(): Promise<void> {
    const actual = new Map((await this.host.list()).map((s) => [s.name, s.status]));
    for (const instance of this.instances.values()) {
      if (instance.status !== "running" && instance.status !== "stopped") continue;
      const status = actual.get(instance.id);
      if (status === undefined)
        this.setStatus(instance.id, "failed", "Sandbox no longer exists on the host");
      else if (status === "running" || status === "stopped") {
        if (status !== instance.status) this.setStatus(instance.id, status);
      }
    }
  }

  get(id: string): Instance {
    const instance = this.instances.get(id);
    if (!instance) throw new ApiError(404, "instance_not_found", `No instance ${id}`);
    return { ...instance };
  }

  async exec(id: string, request: ExecRequest): Promise<ExecResult> {
    const instance = this.requireStatus(id, ["running", "stopped"]);
    // sbx exec starts a stopped sandbox, so reflect that.
    if (instance.status === "stopped") this.setStatus(id, "starting");
    try {
      return await this.host.exec(id, request);
    } finally {
      this.setStatus(id, "running");
    }
  }

  async stop(id: string): Promise<Instance> {
    this.requireStatus(id, ["running", "stopped"]);
    if (this.get(id).status === "stopped") return this.get(id);
    this.setStatus(id, "stopping");
    await this.transition(id, () => this.host.stop(id), "stopped");
    return this.get(id);
  }

  async start(id: string): Promise<Instance> {
    this.requireStatus(id, ["running", "stopped"]);
    if (this.get(id).status === "running") return this.get(id);
    this.setStatus(id, "starting");
    await this.transition(id, () => this.host.start(id), "running");
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
    this.instances.delete(id);
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

  private setStatus(id: string, status: InstanceStatus, error?: string) {
    const instance = this.instances.get(id);
    if (!instance) return;
    instance.status = status;
    instance.updated_at = now();
    if (error) instance.error = error;
    else delete instance.error;
  }
}
