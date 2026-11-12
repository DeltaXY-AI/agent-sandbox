// HostProvider for sbx running on this machine (developed on Windows).
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  createSandbox,
  execInSandbox,
  holdOpen,
  listPorts,
  listSandboxes,
  publishPort,
  removeSandbox,
  setCustomSecret,
  startSandbox,
  stopSandbox,
  type SbxSandbox,
} from "../lib/sbx.ts";
import { FX_TEMPLATE_TAG } from "../templates.ts";
import type { ExecRequest, ExecResult, HostProvider, HostSandbox, SandboxSpec } from "./types.ts";

/** Platform template -> how sbx creates it. */
const TEMPLATES: Record<string, { agent: string; image?: string }> = {
  base: { agent: "shell" },
  fx: { agent: "shell", image: FX_TEMPLATE_TAG },
};

function toHostSandbox(s: SbxSandbox): HostSandbox {
  const status = s.status === "running" || s.status === "stopped" ? s.status : "unknown";
  return { name: s.name, hostId: s.id, status, createdAt: s.created_at };
}

export class LocalWindowsHost implements HostProvider {
  readonly name = "local-windows";
  /**
   * One open exec per sandbox that should stay up. sbx stops an idle sandbox after about
   * 30 s by itself; the platform's own idle timer decides when to sleep instead.
   */
  private readonly holds = new Map<string, ChildProcess>();

  private keepAwake(name: string): void {
    if (this.holds.has(name)) return;
    const child = holdOpen(name);
    this.holds.set(name, child);
    const forget = () => {
      if (this.holds.get(name) === child) this.holds.delete(name);
    };
    child.on("exit", forget);
    child.on("error", forget);
  }

  private letGo(name: string): void {
    const child = this.holds.get(name);
    this.holds.delete(name);
    child?.kill();
    // sbx re-creates port mappings on new host ports after a start (SPEC section 8).
    this.ports.delete(name);
  }

  /** sandbox port -> loopback host port, valid until the sandbox stops. */
  private readonly ports = new Map<string, Map<number, number>>();

  async portAddress(name: string, port: number): Promise<{ host: string; port: number }> {
    let known = this.ports.get(name);
    if (!known) this.ports.set(name, (known = new Map()));
    let hostPort = known.get(port);
    if (hostPort === undefined) {
      // Publishing twice adds a second mapping, so look first.
      const existing = (await listPorts(name)).find((p) => p.sandbox_port === port);
      hostPort = existing?.host_port ?? (await publishPort(name, port)).host_port;
      known.set(port, hostPort);
    }
    return { host: "127.0.0.1", port: hostPort };
  }

  forgetPort(name: string, port: number): void {
    this.ports.get(name)?.delete(port);
  }

  static templates(): string[] {
    return Object.keys(TEMPLATES);
  }

  async createSandbox(spec: SandboxSpec): Promise<HostSandbox> {
    const template = TEMPLATES[spec.template];
    if (!template) throw new Error(`Unknown template ${spec.template}`);
    // The sandbox gets a random placeholder; the sbx proxy swaps in the real value.
    const secrets = (spec.secrets ?? []).map((s) => ({
      ...s,
      placeholder: `${s.env.toLowerCase().replaceAll("_", "-")}-${randomBytes(12).toString("hex")}`,
    }));
    const env = { ...spec.env };
    for (const s of secrets) env[s.env] = s.placeholder;
    const sandbox = await createSandbox({
      name: spec.name,
      agent: template.agent,
      template: template.image,
      env,
      cpus: spec.cpus,
      memory: spec.memory,
    });
    try {
      for (const s of secrets) await setCustomSecret(spec.name, s);
    } catch (err) {
      await removeSandbox(spec.name).catch(() => undefined);
      throw err;
    }
    this.keepAwake(spec.name);
    return toHostSandbox(sandbox);
  }

  async list(): Promise<HostSandbox[]> {
    return (await listSandboxes()).map(toHostSandbox);
  }

  async exec(name: string, request: ExecRequest): Promise<ExecResult> {
    // The platform only execs in awake sandboxes; make sure sbx keeps this one up.
    this.keepAwake(name);
    const result = await execInSandbox(name, request.cmd, {
      user: request.user,
      workdir: request.workdir,
      env: request.env,
      stdin: request.stdin,
      timeoutMs: request.timeoutMs,
      onStdout: request.onStdout,
    });
    // sbx prints "sandbox <name> - started" on stderr when exec auto-starts a stopped sandbox.
    const startedLine = new RegExp(`^\\s*\\S*\\s*sandbox ${name} \\S+ started\\r?\\n`, "m");
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr.replace(startedLine, ""),
      durationMs: result.durationMs,
    };
  }

  stop(name: string): Promise<void> {
    this.letGo(name);
    return stopSandbox(name);
  }

  async start(name: string): Promise<void> {
    await startSandbox(name);
    this.keepAwake(name);
  }

  /** sbx has no pause; stop keeps the disk, and that is what sleep needs. */
  sleep(name: string): Promise<void> {
    this.letGo(name);
    return stopSandbox(name);
  }

  async wake(name: string): Promise<void> {
    await startSandbox(name);
    this.keepAwake(name);
  }

  delete(name: string): Promise<void> {
    this.letGo(name);
    return removeSandbox(name);
  }
}
