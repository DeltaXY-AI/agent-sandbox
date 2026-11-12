// HarnessAdapter for fx (https://github.com/vercel-labs/fx), via `fx ask --json`.
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

const TURN_SCRIPT = "/opt/agent-sandbox/fx-turn.sh";
const WORKDIR = "/home/agent";
const TURN_TIMEOUT_MS = 15 * 60_000;

export function buildFxArgs(input: TurnInput): string[] {
  const args = [TURN_SCRIPT, "--json", "--no-color", "--full-access", "--model", input.model];
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

export const fxAdapter: HarnessAdapter = {
  agent: "fx",
  secrets: [
    { env: "AI_GATEWAY_API_KEY", hosts: ["ai-gateway.vercel.sh"], source: "AI_GATEWAY_API_KEY" },
  ],
  async runTurn(exec: Exec, input: TurnInput): Promise<TurnResult> {
    const result = await exec({
      cmd: buildFxArgs(input),
      workdir: WORKDIR,
      timeoutMs: TURN_TIMEOUT_MS,
    });
    return parseFxResult(result.stdout, result.stderr, result.exitCode);
  },
};
