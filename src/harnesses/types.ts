// HarnessAdapter: the only code that knows a specific agent CLI (SPEC section 2).
// Weekend 1 is non-streaming: runTurn returns the finished turn. startTurn with the
// 9 events replaces it when streaming lands.
import type { ExecRequest, ExecResult } from "../hosts/types.ts";

/** A secret the harness needs inside the sandbox. The host injects it as a placeholder. */
export interface SecretRequirement {
  /** Env var the harness reads inside the sandbox. */
  env: string;
  /** Hosts the real value may be sent to. */
  hosts: string[];
  /** Env var on the control-plane host that holds the real value. */
  source: string;
}

export interface TurnInput {
  input: string;
  model: string;
  /** The harness's own session id from the previous turn, if any. */
  harnessSessionId?: string;
}

export interface ToolCallSummary {
  name: string;
  status: string;
}

export interface TurnResult {
  status: "completed" | "failed";
  outputText: string;
  harnessSessionId?: string;
  usage: { inputTokens: number; outputTokens: number };
  toolCalls: ToolCallSummary[];
  error?: { code: string; message: string };
}

export type Exec = (request: ExecRequest) => Promise<ExecResult>;

export interface HarnessAdapter {
  readonly agent: string;
  readonly secrets: SecretRequirement[];
  runTurn(exec: Exec, input: TurnInput): Promise<TurnResult>;
}
