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
  delete(name: string): Promise<void>;
}
