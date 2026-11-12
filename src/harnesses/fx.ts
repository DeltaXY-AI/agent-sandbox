// HarnessAdapter for fx (https://github.com/vercel-labs/fx). Each turn runs
// templates/fx/fx-turn.mjs, which wraps `fx ask --json` and reports the model's live
// stream and tool results as JSON lines (SPEC section 8, weekend 2 spike).
import type { TurnEvent } from "../events/types.ts";
import { startedData } from "./tool-args.ts";
import type { Exec, HarnessAdapter, TurnInput, TurnResult } from "./types.ts";

/** Fields of `fx ask --json` we use (fx 0.0.16). */
interface FxAskResult {
  output?: string;
  final_output?: string;
  exit_code?: number;
  session_id?: string;
  tool_calls?: { name: string; status: string }[];
  usage?: { input_tokens?: number | null; output_tokens?: number | null };
  auth_failure?: { reason?: string; http_status?: number };
  error?: unknown;
}

/** One line from fx-turn.mjs. */
type TurnLine =
  | { t: "part"; at: number; part: Record<string, unknown> & { type: string } }
  | { t: "tool_result"; at: number; id: string; tool: string; error: string | null }
  | { t: "result"; at: number; exit: number; stdout: string; stderr: string };

const TURN_SCRIPT = "/opt/agent-sandbox/fx-turn.mjs";
const WORKDIR = "/home/agent";
const TURN_TIMEOUT_MS = 15 * 60_000;

export function buildFxArgs(input: TurnInput): string[] {
  const args = ["env", "NODE_USE_ENV_PROXY=1", "node", TURN_SCRIPT];
  args.push("--json", "--no-color", "--full-access", "--model", input.model);
  if (input.harnessSessionId) args.push("--resume", input.harnessSessionId);
  args.push("--", input.input);
  return args;
}

export function parseFxResult(stdout: string, stderr: string, exitCode: number): TurnResult {
  let parsed: FxAskResult | undefined;
  try {
    parsed = JSON.parse(stdout) as FxAskResult;
  } catch {
    parsed = undefined;
  }
  if (!parsed) {
    return {
      status: "failed",
      outputText: "",
      usage: { inputTokens: 0, outputTokens: 0 },
      toolCalls: [],
      error: {
        code: "harness_error",
        message: `fx exited ${exitCode} without JSON: ${(stderr || stdout).trim().slice(0, 500)}`,
      },
    };
  }
  const usage = {
    inputTokens: parsed.usage?.input_tokens ?? 0,
    outputTokens: parsed.usage?.output_tokens ?? 0,
  };
  const base = {
    harnessSessionId: parsed.session_id || undefined,
    usage,
    toolCalls: (parsed.tool_calls ?? []).map((t) => ({ name: t.name, status: t.status })),
  };
  const fxExit = parsed.exit_code ?? exitCode;
  if (fxExit !== 0) {
    return {
      ...base,
      status: "failed",
      outputText: "",
      error: {
        code: parsed.auth_failure ? "model_auth_failed" : "harness_error",
        message: (parsed.output ?? stderr).trim() || `fx exited ${fxExit}`,
      },
    };
  }
  return {
    ...base,
    status: "completed",
    outputText: (parsed.final_output || parsed.output || "").trim(),
  };
}

/**
 * Turns fx-turn.mjs lines into TurnEvents. Feed stdout chunks with `push`, then call
 * `finish` with the exec exit code to get the TurnResult.
 */
export class FxTurnParser {
  private pending = "";
  private result: Extract<TurnLine, { t: "result" }> | undefined;
  /** Tool calls started and not yet finished, by call id. */
  private readonly open = new Map<string, { tool: string; at: number }>();

  private readonly onEvent: (e: TurnEvent) => void;

  constructor(onEvent: (e: TurnEvent) => void = () => undefined) {
    this.onEvent = onEvent;
  }

  push(chunk: string): void {
    this.pending += chunk;
    let nl;
    while ((nl = this.pending.indexOf("\n")) !== -1) {
      const line = this.pending.slice(0, nl).trim();
      this.pending = this.pending.slice(nl + 1);
      if (line) this.line(line);
    }
  }

  finish(execExitCode: number, execStderr: string): TurnResult {
    if (this.pending.trim()) this.line(this.pending.trim());
    this.pending = "";
    const turn = this.result
      ? parseFxResult(this.result.stdout, this.result.stderr, this.result.exit)
      : parseFxResult("", execStderr || "fx-turn.mjs ended without a result", execExitCode);
    // Calls whose result never came back (the turn ended first).
    for (const [id, call] of this.open) {
      if (turn.status === "completed") {
        this.onEvent({ event: "response.tool_call.completed", data: { tool: call.tool } });
      } else {
        this.onEvent({
          event: "response.tool_call.failed",
          data: { tool: call.tool, error: "The turn ended before the tool finished" },
        });
      }
      this.open.delete(id);
    }
    return turn;
  }

  private line(text: string): void {
    let line: TurnLine;
    try {
      line = JSON.parse(text) as TurnLine;
    } catch {
      return; // not ours
    }
    if (line.t === "result") {
      this.result = line;
      return;
    }
    if (line.t === "tool_result") {
      const call = this.open.get(line.id);
      this.open.delete(line.id);
      const tool = call?.tool ?? line.tool;
      if (line.error) {
        this.onEvent({ event: "response.tool_call.failed", data: { tool, error: line.error } });
      } else {
        const data: { tool: string; duration_ms?: number } = { tool };
        if (call) data.duration_ms = Math.max(0, line.at - call.at);
        this.onEvent({ event: "response.tool_call.completed", data });
      }
      return;
    }
    if (line.t !== "part") return;
    const p = line.part;
    if (p.type === "text-delta" && typeof p.delta === "string" && p.delta) {
      this.onEvent({ event: "response.output_text.delta", data: { text: p.delta } });
    } else if (p.type === "reasoning-delta" && typeof p.delta === "string" && p.delta) {
      this.onEvent({ event: "response.reasoning.delta", data: { text: p.delta } });
    } else if (p.type === "tool-input-start" && typeof p.toolName === "string") {
      this.onEvent({ event: "response.tool_call.generating", data: { tool: p.toolName } });
    } else if (p.type === "tool-call" && typeof p.toolName === "string") {
      const data = startedData(p.toolName, p.input);
      if (typeof p.toolCallId === "string") {
        this.open.set(p.toolCallId, { tool: p.toolName, at: line.at });
      }
      this.onEvent({ event: "response.tool_call.started", data });
    }
  }
}

export const fxAdapter: HarnessAdapter = {
  agent: "fx",
  secrets: [
    { env: "AI_GATEWAY_API_KEY", hosts: ["ai-gateway.vercel.sh"], source: "AI_GATEWAY_API_KEY" },
  ],
  async runTurn(exec: Exec, input: TurnInput, onEvent): Promise<TurnResult> {
    const parser = new FxTurnParser(onEvent);
    const result = await exec({
      cmd: buildFxArgs(input),
      workdir: WORKDIR,
      timeoutMs: TURN_TIMEOUT_MS,
      onStdout: (chunk) => parser.push(chunk),
    });
    return parser.finish(result.exitCode, result.stderr);
  },
};
