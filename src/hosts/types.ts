// HostProvider: the only code that knows where sandboxes run (SPEC section 2).

export type HostStatus = "running" | "stopped" | "unknown";

export interface HostSandbox {
  name: string;
  hostId: string;
  status: HostStatus;
  createdAt: string;
}

export interface SandboxSpec {
  name: string;
  /** Platform template name: "base", "fx", ... The provider maps it to its own image. */
  template: string;
  env?: Record<string, string>;
  /** Injected so the sandbox never holds the real value (placeholder + proxy on sbx). */
  secrets?: SandboxSecret[];
  cpus?: number;
  memory?: string;
}

export interface SandboxSecret {
  env: string;
  hosts: string[];
  value: string;
}

export interface ExecRequest {
  cmd: string[];
  user?: string;
  workdir?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
  /** Receives stdout chunks live while the command runs. stdout is still returned at the end. */
  onStdout?: (chunk: string) => void;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface HostProvider {
  readonly name: string;
  createSandbox(spec: SandboxSpec): Promise<HostSandbox>;
  list(): Promise<HostSandbox[]>;
  exec(name: string, request: ExecRequest): Promise<ExecResult>;
  stop(name: string): Promise<void>;
  start(name: string): Promise<void>;
  /** Pause a sandbox and keep its disk (SPEC section 4). sbx: stop. Firecracker: snapshot. */
  sleep(name: string): Promise<void>;
  /** Resume a sleeping sandbox. sbx: start. Firecracker: restore the snapshot. */
  wake(name: string): Promise<void>;
  /**
   * Where the control plane can reach `port` inside an awake sandbox (publishing it if
   * needed). The address may change after a wake; call again rather than caching.
   */
  portAddress(name: string, port: number): Promise<{ host: string; port: number }>;
  /** Forget a cached address that stopped answering. */
  forgetPort(name: string, port: number): void;
  /**
   * Create a new sandbox (`spec`) whose disk is a copy of `source`'s: files, installed
   * packages, the agent's session files. Not copied: running processes, create-time env
   * (pass it again in `spec`), secrets (new ones come from `spec`). The source ends in
   * the state it was in. sbx: stop, template save, create from it. Firecracker: snapshot.
   */
  fork(source: string, spec: SandboxSpec): Promise<HostSandbox>;
  delete(name: string): Promise<void>;
}
