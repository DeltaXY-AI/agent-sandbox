// The 9 public streaming events (SPEC section 3). Payloads follow Agent37's streaming docs.
// Every harness produces exactly these; nothing harness-specific reaches the public API.

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

export interface ApiErrorBody {
  code: string;
  message: string;
}

export type ResponseEvent =
  | { event: "response.created"; data: { id: string; session_id: string } }
  | { event: "response.reasoning.delta"; data: { text: string } }
  | { event: "response.output_text.delta"; data: { text: string } }
  | { event: "response.tool_call.generating"; data: { tool: string } }
  | {
      event: "response.tool_call.started";
      data: { tool: string; label?: string; arguments?: Record<string, unknown> };
    }
  | { event: "response.tool_call.completed"; data: { tool: string; duration_ms?: number } }
  | { event: "response.tool_call.failed"; data: { tool: string; error?: string } }
  | {
      event: "response.completed";
      data: {
        output_text: string;
        usage: Usage | null;
        context: null;
        reasoning_effort: string | null;
      };
    }
  | { event: "response.failed"; data: { error: ApiErrorBody } };

export type EventName = ResponseEvent["event"];

export const EVENT_NAMES: readonly EventName[] = [
  "response.created",
  "response.reasoning.delta",
  "response.output_text.delta",
  "response.tool_call.generating",
  "response.tool_call.started",
  "response.tool_call.completed",
  "response.tool_call.failed",
  "response.completed",
  "response.failed",
];

export const isTerminal = (e: ResponseEvent) =>
  e.event === "response.completed" || e.event === "response.failed";

/**
 * What a HarnessAdapter reports while a turn runs. The agent API adds
 * response.created, response.completed and response.failed itself.
 */
export type TurnEvent = Exclude<
  ResponseEvent,
  { event: "response.created" | "response.completed" | "response.failed" }
>;
