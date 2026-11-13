import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkEvent, CORE_EVENTS, crossCheck, shapeOf } from "../src/events/schema.ts";
import type { TurnEvent } from "../src/events/types.ts";
import { EveTurnParser } from "../src/harnesses/eve.ts";
import { FxTurnParser } from "../src/harnesses/fx.ts";
import { PiTurnParser } from "../src/harnesses/pi.ts";

// Real hello.py turns of each harness (Nov 12-13, 2026), through their adapters.
type Parser = { push(chunk: string): void; finish(code: number, stderr: string): unknown };
function eventsOf(make: (on: (e: TurnEvent) => void) => Parser, fixture: string): TurnEvent[] {
  const events: TurnEvent[] = [];
  const parser = make((e) => events.push(e));
  parser.push(readFileSync(`test/fixtures/${fixture}`, "utf8"));
  parser.finish(0, "");
  return events;
}

// response.created and response.completed come from the Agent API, not the adapters.
const ADAPTER_CORE = CORE_EVENTS.filter(
  (e) => e !== "response.created" && e !== "response.completed",
);

describe("cross-check (step 11) on recorded turns", () => {
  it("fx, Pi and eve send the core events with identical field shapes", () => {
    const result = crossCheck(
      {
        fx: eventsOf((on) => new FxTurnParser(on), "fx-0.0.16-hello-turn.jsonl"),
        pi: eventsOf((on) => new PiTurnParser(on), "pi-1.5.2-hello-turn.jsonl"),
        eve: eventsOf((on) => new EveTurnParser(on), "eve-1.0.0-rc.10-hello-turn.jsonl"),
      },
      ADAPTER_CORE,
    );
    expect(result.problems).toEqual([]);
    expect(result.shapes["response.tool_call.started"]).toEqual({
      fx: ["{arguments:object,label:string,tool:string}"],
      pi: ["{arguments:object,label:string,tool:string}"],
      eve: ["{arguments:object,label:string,tool:string}"],
    });
    expect(result.shapes["response.tool_call.completed"]?.eve).toEqual([
      "{duration_ms:number,tool:string}",
    ]);
  });
});

describe("event schema", () => {
  it("accepts the spec's payloads and names what is wrong", () => {
    expect(checkEvent("response.created", { id: "r", session_id: "s" })).toEqual([]);
    expect(
      checkEvent("response.completed", {
        output_text: "x",
        usage: null,
        context: null,
        reasoning_effort: null,
      }),
    ).toEqual([]);
    expect(
      checkEvent("response.completed", {
        output_text: "x",
        usage: { input_tokens: 1, output_tokens: "2" },
        context: null,
        reasoning_effort: null,
      }),
    ).toEqual(["response.completed.usage.output_tokens: string, want number"]);
    expect(checkEvent("response.tool_call.started", { tool: "bash", cwd: "/" })).toEqual([
      "response.tool_call.started.cwd: not in the spec",
    ]);
    expect(checkEvent("response.failed", { error: { code: "x" } })).toEqual([
      "response.failed.error.message: missing",
    ]);
    expect(checkEvent("response.tool_call.progress", {})).toEqual([
      "response.tool_call.progress: not one of the 9 events",
    ]);
  });

  it("shapes nest where the spec nests and ignore values", () => {
    expect(
      shapeOf("response.completed", {
        output_text: "a",
        usage: { input_tokens: 1, output_tokens: 2 },
        context: null,
        reasoning_effort: null,
      }),
    ).toBe(
      "{context:null,output_text:string,reasoning_effort:null,usage:{input_tokens:number,output_tokens:number}}",
    );
    expect(shapeOf("response.tool_call.started", { tool: "x", arguments: { a: 1 } })).toBe(
      "{arguments:object,tool:string}",
    );
  });

  it("reports a missing core event and a shape mismatch", () => {
    const r = crossCheck(
      {
        a: [{ event: "response.tool_call.completed", data: { tool: "x", duration_ms: 3 } }],
        b: [{ event: "response.tool_call.completed", data: { tool: "y" } }],
      },
      ["response.tool_call.completed", "response.output_text.delta"],
    );
    expect(r.problems).toEqual([
      "a: never sent response.output_text.delta",
      "b: never sent response.output_text.delta",
      "response.tool_call.completed: a sends {duration_ms:number,tool:string}, b sends {tool:string}",
    ]);
  });
});
