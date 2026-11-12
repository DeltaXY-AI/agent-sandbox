// HarnessAdapter for eve (https://github.com/vercel/eve). The template holds a built eve
// agent project; each turn runs templates/eve/eve-turn.mjs, which starts `eve start` when
// needed, sends the message to the eve session and relays the session's NDJSON stream
// (stream version 27) until the turn settles (SPEC section 8, eve spike).
import type { TurnEvent } from "../events/types.ts";
import { startedData } from "./tool-args.ts";
import type { Exec, HarnessAdapter, ToolCallSummary, TurnInput, TurnResult } from "./types.ts";

const SHIM = "/opt/agent-sandbox/eve-turn.mjs";
const NODE = "/opt/node24/bin/node";
const PATH = "/opt/node24/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const WORKDIR = "/home/agent";
const TURN_TIMEOUT_MS = 15 * 60_000;

/** One eve fact: `{type, scope?, data}` (stream version 27). */
interface Fact {
  type: string;
  data?: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}
/** A stream line: an event line `{at, facts}` or a progress record `{progress: Fact}`. */
interface StreamLine {
  at?: string;
  facts?: Fact[];
  progress?: Fact;
}
type ShimLine =
  | { t: "session"; id: string }
  | { t: "line"; line: StreamLine }
  | { t: "end"; outcome: string }
  | { t: "error"; message: string };

export function buildEveArgs(input: TurnInput): string[] {
  const args = [NODE, SHIM, input.input];
  if (input.harnessSessionId) args.push(input.harnessSessionId);
  return args;
}

/** Turns eve-turn.mjs lines into TurnEvents. Feed stdout chunks with `push`, then `finish`. */
export class EveTurnParser {
  private pending = "";
  private sessionId: string | undefined;
  private outcome: string | undefined;
  private failure: string | undefined;
  /** Text kind of each content part; eve sends `kind` only on a part's first delta. */
  private readonly partKinds = new Map<string, string>();
  private readonly generating = new Set<string>();
  private readonly calls = new Map<string, { tool: string; hidden: boolean; startedAt?: number }>();
  private readonly replies: string[] = [];
  private readonly usage = { inputTokens: 0, outputTokens: 0 };
  private readonly toolCalls: ToolCallSummary[] = [];
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

  finish(exitCode: number, stderr: string): TurnResult {
    if (this.pending.trim()) this.line(this.pending.trim());
    this.pending = "";
    const base = { harnessSessionId: this.sessionId, usage: this.usage, toolCalls: this.toolCalls };
    if (this.outcome === "completed") {
      return { ...base, status: "completed", outputText: this.replies.join("\n\n").trim() };
    }
    const message =
      this.failure ??
      (this.outcome === "paused"
        ? "The eve agent paused for approval or input, which a headless turn cannot give"
        : this.outcome
          ? `eve turn ended: ${this.outcome}`
          : stderr.trim().slice(0, 500) || `eve-turn.mjs exited ${exitCode} without a result`);
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

  private line(text: string): void {
    let line: ShimLine;
    try {
      line = JSON.parse(text) as ShimLine;
    } catch {
      return; // not ours
    }
    if (line.t === "session") this.sessionId = line.id;
    else if (line.t === "end") this.outcome = line.outcome;
    else if (line.t === "error") this.failure = line.message;
    else if (line.t === "line") {
      const at = line.line.at ? Date.parse(line.line.at) : undefined;
      if (line.line.progress) this.fact(line.line.progress, at);
      for (const fact of line.line.facts ?? []) this.fact(fact, at);
    }
  }

  private fact(f: Fact, at: number | undefined): void {
    const d = f.data ?? {};
    switch (f.type) {
      case "content.delta": {
        const partId = String(d.partId ?? "");
        if (d.kind) this.partKinds.set(partId, String(d.kind));
        const kind = this.partKinds.get(partId) ?? "text";
        if (typeof d.delta !== "string" || !d.delta) return;
        if (kind === "text") {
          this.onEvent({ event: "response.output_text.delta", data: { text: d.delta } });
        } else if (kind === "reasoning") {
          this.onEvent({ event: "response.reasoning.delta", data: { text: d.delta } });
        }
        return;
      }
      case "call.input": {
        // The model is still writing the call's arguments; the name comes on the first record.
        const id = String(d.callId ?? "");
        if (d.name && !this.generating.has(id)) {
          this.generating.add(id);
          this.onEvent({ event: "response.tool_call.generating", data: { tool: String(d.name) } });
        }
        return;
      }
      case "call.requested": {
        const capability = (d.capability ?? {}) as {
          name?: string;
          label?: string;
          hidden?: boolean;
        };
        const tool = capability.name ?? "tool";
        const hidden = Boolean(capability.hidden);
        this.calls.set(String(d.callId), { tool, hidden });
        if (hidden) return;
        const data = startedData(tool, d.input);
        if (capability.label) data.label = capability.label;
        this.onEvent({ event: "response.tool_call.started", data });
        return;
      }
      case "call.started": {
        const call = this.calls.get(String(d.callId));
        if (call && at !== undefined) call.startedAt = at;
        return;
      }
      case "call.settled": {
        const call = this.calls.get(String(d.callId));
        if (!call) return;
        this.calls.delete(String(d.callId));
        const ok = d.outcome === "completed";
        this.toolCalls.push({ name: call.tool, status: ok ? "success" : String(d.outcome) });
        if (call.hidden) return;
        if (ok) {
          const data: { tool: string; duration_ms?: number } = { tool: call.tool };
          if (call.startedAt !== undefined && at !== undefined) {
            data.duration_ms = Math.max(0, at - call.startedAt);
          }
          this.onEvent({ event: "response.tool_call.completed", data });
        } else {
          const error = (d.error?.message as string | undefined) ?? `Tool ${d.outcome}`;
          this.onEvent({ event: "response.tool_call.failed", data: { tool: call.tool, error } });
        }
        return;
      }
      case "usage.recorded": {
        // eve's inputTokens already include cached tokens.
        if (d.kind !== "model") return;
        this.usage.inputTokens += Number(d.usage?.inputTokens ?? 0);
        this.usage.outputTokens += Number(d.usage?.outputTokens ?? 0);
        return;
      }
      case "content.completed": {
        if (d.phase === "reply" && d.kind === "text" && typeof d.value === "string") {
          this.replies.push(d.value);
        }
        return;
      }
      case "turn.settled": {
        if (d.outcome !== "completed" && d.error?.message) this.failure = String(d.error.message);
        return;
      }
    }
  }
}

export const eveAdapter: HarnessAdapter = {
  agent: "eve",
  secrets: [
    { env: "AI_GATEWAY_API_KEY", hosts: ["ai-gateway.vercel.sh"], source: "AI_GATEWAY_API_KEY" },
  ],
  async runTurn(exec: Exec, input: TurnInput, onEvent): Promise<TurnResult> {
    // The eve project fixes its own model (agent/agent.ts); input.model is not applied.
    const parser = new EveTurnParser(onEvent);
    const result = await exec({
      cmd: buildEveArgs(input),
      workdir: WORKDIR,
      env: { PATH, EVE_TELEMETRY_DISABLED: "1" },
      timeoutMs: TURN_TIMEOUT_MS,
      onStdout: (chunk) => parser.push(chunk),
    });
    return parser.finish(result.exitCode, result.stderr);
  },
};
