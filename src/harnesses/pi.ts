// HarnessAdapter for Pi (https://pi.dev, npm @earendil-works/pi-coding-agent), via
// `pi --mode json`: one turn per exec, JSON lines on stdout (SPEC section 8, Pi spike).
// Pi talks through HTTPS_PROXY, so the sbx proxy swaps the placeholder key; no relay.
import { randomUUID } from "node:crypto";
import type { TurnEvent } from "../events/types.ts";
import { startedData } from "./tool-args.ts";
import type { Exec, HarnessAdapter, ToolCallSummary, TurnInput, TurnResult } from "./types.ts";

const WORKDIR = "/home/agent";
const TURN_TIMEOUT_MS = 15 * 60_000;
const PROVIDER = "vercel-ai-gateway";

/** Fields of Pi's events we use (Pi 1.5.2, docs/json.md). */
interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}
interface PiMessage {
  role: string;
  content?: { type: string; text?: string }[];
  stopReason?: string;
  errorMessage?: string;
  usage?: PiUsage;
}
type PiEvent =
  | { type: "session"; id: string }
  | {
      type: "message_update";
      assistantMessageEvent: { type: string; delta?: string; toolName?: string };
    }
  | { type: "message_end"; message: PiMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args?: unknown }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      isError: boolean;
      durationMs?: number;
      result?: { content?: { type: string; text?: string }[] };
    }
  | { type: "agent_settled"; aborted?: boolean }
  | { type: string };

export function buildPiArgs(input: TurnInput, sessionId: string): string[] {
  // Pi reads piped stdin until EOF and never starts while stdin stays open, so close it.
  return [
    "sh",
    "-c",
    'exec pi "$@" </dev/null',
    "pi",
    "--mode",
    "json",
    "--provider",
    PROVIDER,
    "--model",
    input.model,
    "--session-id",
    sessionId,
    // Headless: do not load project-local Pi settings or extensions from the workspace.
    "--no-approve",
    // Everything after -- is the prompt (a prompt starting with @ still names a file).
    "--",
    input.input,
  ];
}

const textOf = (content?: { type: string; text?: string }[]) =>
  (content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");

/** Turns Pi's JSON lines into TurnEvents. Feed stdout chunks with `push`, then `finish`. */
export class PiTurnParser {
  private pending = "";
  private sessionId: string | undefined;
  private lastAssistant: PiMessage | undefined;
  private settled = false;
  private readonly usage = { inputTokens: 0, outputTokens: 0 };
  private readonly toolCalls: ToolCallSummary[] = [];
  private readonly onEvent: (e: TurnEvent) => void;

  constructor(onEvent: (e: TurnEvent) => void = () => undefined) {
    this.onEvent = onEvent;
  }

  push(chunk: string): void {
    this.pending += chunk;
    // Split on LF only: Pi's docs warn that readline also splits on U+2028/U+2029.
    let nl;
    while ((nl = this.pending.indexOf("\n")) !== -1) {
      const line = this.pending.slice(0, nl).trim();
      this.pending = this.pending.slice(nl + 1);
      if (line) this.line(line);
    }
  }

  finish(exitCode: number, stderr: string): TurnResult {
    if (this.pending.trim()) this.line(this.pending.trim());
    this.pending = "";
    const base = {
      harnessSessionId: this.sessionId,
      usage: this.usage,
      toolCalls: this.toolCalls,
    };
    const last = this.lastAssistant;
    // Pi exits 0 on a failed turn; the last assistant message says how it ended.
    if (!last || !this.settled || last.stopReason === "error" || last.stopReason === "aborted") {
      const message =
        last?.errorMessage ||
        (last?.stopReason === "aborted" ? "Pi aborted the turn" : "") ||
        stderr.trim().slice(0, 500) ||
        `pi exited ${exitCode} without finishing the turn`;
      return {
        ...base,
        status: "failed",
        outputText: "",
        error: {
          code: /\b401\b|authentication|api key/i.test(message)
            ? "model_auth_failed"
            : "harness_error",
          message,
        },
      };
    }
    return { ...base, status: "completed", outputText: textOf(last.content).trim() };
  }

  private line(text: string): void {
    let e: PiEvent;
    try {
      e = JSON.parse(text) as PiEvent;
    } catch {
      return; // not a Pi event
    }
    switch (e.type) {
      case "session":
        this.sessionId = (e as { id: string }).id;
        return;
      case "message_update": {
        const m = (e as Extract<PiEvent, { type: "message_update" }>).assistantMessageEvent;
        if (m.type === "text_delta" && m.delta) {
          this.onEvent({ event: "response.output_text.delta", data: { text: m.delta } });
        } else if (m.type === "thinking_delta" && m.delta) {
          this.onEvent({ event: "response.reasoning.delta", data: { text: m.delta } });
        } else if (m.type === "toolcall_start" && m.toolName) {
          this.onEvent({ event: "response.tool_call.generating", data: { tool: m.toolName } });
        }
        return;
      }
      case "tool_execution_start": {
        const t = e as Extract<PiEvent, { type: "tool_execution_start" }>;
        this.onEvent({
          event: "response.tool_call.started",
          data: startedData(t.toolName, t.args),
        });
        return;
      }
      case "tool_execution_end": {
        const t = e as Extract<PiEvent, { type: "tool_execution_end" }>;
        this.toolCalls.push({ name: t.toolName, status: t.isError ? "error" : "success" });
        if (t.isError) {
          const error = textOf(t.result?.content).slice(0, 300) || "Tool failed";
          this.onEvent({ event: "response.tool_call.failed", data: { tool: t.toolName, error } });
        } else {
          const data: { tool: string; duration_ms?: number } = { tool: t.toolName };
          if (typeof t.durationMs === "number") data.duration_ms = t.durationMs;
          this.onEvent({ event: "response.tool_call.completed", data });
        }
        return;
      }
      case "message_end": {
        const m = (e as Extract<PiEvent, { type: "message_end" }>).message;
        if (m.role !== "assistant") return;
        this.lastAssistant = m;
        // Input counts every prompt token, cached or not, as fx's usage does.
        const u = m.usage ?? {};
        this.usage.inputTokens += (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
        this.usage.outputTokens += u.output ?? 0;
        return;
      }
      case "agent_settled":
        this.settled = true;
        return;
    }
  }
}

export const piAdapter: HarnessAdapter = {
  agent: "pi",
  secrets: [
    { env: "AI_GATEWAY_API_KEY", hosts: ["ai-gateway.vercel.sh"], source: "AI_GATEWAY_API_KEY" },
  ],
  async runTurn(exec: Exec, input: TurnInput, onEvent): Promise<TurnResult> {
    // We choose the session id, so the first turn and every later one name the same session.
    const sessionId = input.harnessSessionId ?? randomUUID();
    const parser = new PiTurnParser(onEvent);
    const result = await exec({
      cmd: buildPiArgs(input, sessionId),
      workdir: WORKDIR,
      env: { PI_OFFLINE: "1", PI_TELEMETRY: "0" },
      timeoutMs: TURN_TIMEOUT_MS,
      onStdout: (chunk) => parser.push(chunk),
    });
    const turn = parser.finish(result.exitCode, result.stderr);
    return { ...turn, harnessSessionId: turn.harnessSessionId ?? sessionId };
  },
};
