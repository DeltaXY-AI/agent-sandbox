// HostProvider for sbx running on this machine (developed on Windows).
import { randomBytes } from "node:crypto";
import {
  createSandbox,
  execInSandbox,
  listSandboxes,
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
    return toHostSandbox(sandbox);
  }

  async list(): Promise<HostSandbox[]> {
    return (await listSandboxes()).map(toHostSandbox);
  }

  async exec(name: string, request: ExecRequest): Promise<ExecResult> {
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
    return stopSandbox(name);
  }

  start(name: string): Promise<void> {
    return startSandbox(name);
  }

  delete(name: string): Promise<void> {
    return removeSandbox(name);
  }
}
