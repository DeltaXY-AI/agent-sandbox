// Thin wrapper over the `sbx` CLI. Knows nothing about our API or harnesses.
import { spawn } from "node:child_process";

export interface SbxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export interface SbxSandbox {
  name: string;
  id: string;
  agent: string;
  status: string;
  created_at: string;
  last_used_at?: string;
  workspaces?: string[];
}

/** sbx itself could not run the command (exit 125), or a management command failed. */
export class SbxError extends Error {
  readonly args: string[];
  readonly result: SbxResult;

  constructor(args: string[], result: SbxResult) {
    const detail = result.stderr.trim() || result.stdout.trim() || "no output";
    super(`sbx ${args[0] ?? ""} failed (exit ${result.exitCode}): ${detail}`);
    this.name = "SbxError";
    this.args = args;
    this.result = result;
  }
}

export const SBX_FAILED = 125;

export interface RunOptions {
  timeoutMs?: number;
  stdin?: string;
  /** Called with each stdout chunk as it arrives (sbx exec streams live). */
  onStdout?: (chunk: string) => void;
}

/** Exit code reported when sbx was killed for running past its timeout (like `timeout`). */
export const SBX_TIMED_OUT = 124;

/**
 * Run `sbx <args>` and return output and exit code. Never throws on a non-zero exit.
 * Past `timeoutMs` sbx is killed and the result is exit 124. On Windows a killed sbx can
 * leave a child holding stdout open, so the result comes from the process exit, not from
 * the pipes closing (a hung `sbx exec` once held a request for 20 minutes, Nov 13, 2026).
 */
export function runSbx(args: string[], options: RunOptions = {}): Promise<SbxResult> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn("sbx", args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      resolve({
        stdout,
        stderr: timedOut
          ? `${stderr}\nsbx ${args[0] ?? ""} timed out after ${options.timeoutMs} ms`
          : signal
            ? `${stderr}\nkilled by ${signal}`
            : stderr,
        exitCode: timedOut ? SBX_TIMED_OUT : (code ?? -1),
        durationMs: Date.now() - started,
      });
    };
    let grace: ReturnType<typeof setTimeout> | undefined;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
          // Do not wait on pipes a grandchild may hold; give the exit event a moment.
          grace = setTimeout(() => finish(null, null), 5_000);
        }, options.timeoutMs)
      : undefined;
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      options.onStdout?.(chunk);
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    // Normally "close" (all output read). After a kill, "exit" is enough.
    child.on("close", finish);
    child.on("exit", (code, signal) => {
      if (timedOut) finish(code, signal);
    });
    child.stdin.end(options.stdin ?? "");
  });
}

/** Management commands (ls, stop, rm, ports, policy) that take longer than this are stuck. */
const MANAGEMENT_TIMEOUT_MS = 2 * 60_000;

/** Run a management command (create, rm, stop, ls). Any non-zero exit is an error. */
export async function runSbxOk(args: string[], options?: RunOptions): Promise<SbxResult> {
  const result = await runSbx(args, { timeoutMs: MANAGEMENT_TIMEOUT_MS, ...options });
  if (result.exitCode !== 0) throw new SbxError(args, result);
  return result;
}

export async function listSandboxes(): Promise<SbxSandbox[]> {
  const result = await runSbxOk(["ls", "--json"]);
  return JSON.parse(result.stdout) as SbxSandbox[];
}

export async function findSandbox(name: string): Promise<SbxSandbox | undefined> {
  return (await listSandboxes()).find((s) => s.name === name);
}

export interface CreateOptions {
  name: string;
  /** Built-in agent or kit. `shell` for a plain Linux sandbox. */
  agent?: string;
  /** Saved template image (`sbx template save`). */
  template?: string;
  env?: Record<string, string>;
  cpus?: number;
  memory?: string;
}

export async function createSandbox(options: CreateOptions): Promise<SbxSandbox> {
  const args = ["create", options.agent ?? "shell", "--name", options.name, "--no-progress"];
  // Saved local templates must not be pulled from a registry.
  if (options.template) args.push("--template", options.template, "--pull", "never");
  if (options.cpus) args.push("--cpus", String(options.cpus));
  if (options.memory) args.push("--memory", options.memory);
  for (const [key, value] of Object.entries(options.env ?? {}))
    args.push("--env", `${key}=${value}`);
  await runSbxOk(args, { timeoutMs: 10 * 60_000 });
  const sandbox = await findSandbox(options.name);
  if (!sandbox) throw new Error(`sbx create reported success but ${options.name} is not listed`);
  return sandbox;
}

export interface ExecOptions extends RunOptions {
  user?: string;
  workdir?: string;
  env?: Record<string, string>;
}

/**
 * Run a command inside a sandbox. Returns the command's own exit code.
 * Throws SbxError only when sbx could not run it (exit 125).
 * A stopped sandbox is started first by sbx.
 */
export async function execInSandbox(
  name: string,
  cmd: string[],
  options: ExecOptions = {},
): Promise<SbxResult> {
  const args = ["exec"];
  if (options.user) args.push("--user", options.user);
  if (options.workdir) args.push("--workdir", options.workdir);
  for (const [key, value] of Object.entries(options.env ?? {}))
    args.push("--env", `${key}=${value}`);
  if (options.stdin !== undefined) args.push("--interactive");
  args.push(name, ...cmd);
  const result = await runSbx(args, options);
  if (result.exitCode === SBX_FAILED) throw new SbxError(args, result);
  return result;
}

export async function stopSandbox(name: string): Promise<void> {
  await runSbxOk(["stop", name]);
}

/** There is no local `sbx start`; exec starts a stopped sandbox. */
/**
 * Keep a sandbox from stopping by itself. sbx v0.50.1 stops a local sandbox about 30 s
 * after its last exec ends (no setting changes this); an exec that stays open holds it up.
 * Kill the returned process to let go. Exits by itself if the sandbox stops.
 */
export function holdOpen(name: string) {
  return spawn("sbx", ["exec", name, "sleep", "infinity"], {
    stdio: "ignore",
    windowsHide: true,
  });
}

/** Block one sandbox from these network resources (hosts, CIDRs). Removed by `sbx rm`. */
export async function denyNetwork(name: string, resources: string[]): Promise<void> {
  for (const resource of resources) {
    await runSbxOk(["policy", "deny", "network", "--sandbox", name, resource]);
  }
}

export interface SbxPort {
  host_ip: string;
  host_port: number;
  sandbox_port: number;
  protocol: string;
}

export async function listPorts(name: string): Promise<SbxPort[]> {
  const result = await runSbxOk(["ports", name, "--json"]);
  return result.stdout.trim() ? (JSON.parse(result.stdout) as SbxPort[]) : [];
}

/** Publish a sandbox port on an ephemeral loopback port. Publishing twice adds a second mapping. */
export async function publishPort(name: string, port: number): Promise<SbxPort> {
  const result = await runSbxOk(["ports", name, "--publish", String(port), "--json"]);
  const [mapping] = JSON.parse(result.stdout) as SbxPort[];
  if (!mapping) throw new Error(`sbx ports --publish ${port} returned no mapping`);
  return mapping;
}

export async function startSandbox(name: string): Promise<void> {
  await execInSandbox(name, ["true"]);
}

export async function removeSandbox(name: string): Promise<void> {
  await runSbxOk(["rm", "--force", name]);
}

/** Copy a host file or directory into a sandbox. */
export async function copyToSandbox(name: string, hostPath: string, sandboxPath: string) {
  await runSbxOk(["cp", hostPath, `${name}:${sandboxPath}`]);
}

/** Snapshot a sandbox as a local template. The sandbox must be stopped (a running one prompts). */
export async function saveTemplate(name: string, tag: string): Promise<void> {
  await runSbxOk(["template", "save", name, tag], { timeoutMs: 10 * 60_000 });
}

/**
 * Remove a saved template image. Sandboxes already created from it keep working, also
 * after a restart (sbx v0.50.1). Without --force sbx asks for confirmation on a terminal.
 */
export async function removeTemplate(tag: string): Promise<void> {
  await runSbxOk(["template", "rm", "--force", tag]);
}

export interface CustomSecret {
  /** Hosts the proxy substitutes the secret for. */
  hosts: string[];
  /** Env var name the sandbox uses. */
  env: string;
  /** Value the sandbox sees. Not secret. */
  placeholder: string;
  value: string;
}

/**
 * Register a sandbox-scoped secret: the sandbox only sees the placeholder, the sbx proxy
 * swaps in the real value on requests to the hosts. Removed by `sbx rm`.
 */
export async function setCustomSecret(name: string, secret: CustomSecret): Promise<void> {
  const args = ["secret", "set-custom", "--sandbox", name, "--env", secret.env];
  for (const host of secret.hosts) args.push("--host", host);
  args.push("--placeholder", secret.placeholder, "--value", secret.value);
  const result = await runSbx(args);
  if (result.exitCode !== 0) {
    // Never include args here: they contain the secret value.
    const detail = (result.stderr || result.stdout).replaceAll(secret.value, "<redacted>");
    throw new Error(`sbx secret set-custom failed (exit ${result.exitCode}): ${detail.trim()}`);
  }
}
