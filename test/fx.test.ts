import { describe, expect, it } from "vitest";
import type { TurnEvent } from "../src/events/types.ts";
import { buildFxArgs, FxTurnParser, parseFxResult } from "../src/harnesses/fx.ts";

// fx-turn.mjs lines, shaped like a real hello.py turn (fx 0.0.16, Nov 12, 2026).
const line = (o: object) => JSON.stringify(o) + "\n";
const TURN_LINES = [
  line({ t: "part", at: 100, part: { type: "reasoning-delta", id: "r", delta: "Plan." } }),
  line({ t: "part", at: 110, part: { type: "text-delta", id: "m", delta: "I'll create" } }),
  line({
    t: "part",
    at: 120,
    part: { type: "tool-input-start", id: "c1", toolName: "write_file" },
  }),
  line({
    t: "part",
    at: 130,
    part: {
      type: "tool-call",
      toolCallId: "c1",
      toolName: "write_file",
      input: JSON.stringify({ path: "/home/agent/hello.py", content: "x".repeat(500) }),
    },
  }),
  line({ t: "tool_result", at: 150, id: "c1", tool: "write_file", error: null }),
  line({
    t: "part",
    at: 160,
    part: { type: "tool-call", toolCallId: "c2", toolName: "shell", input: { command: "ls /x" } },
  }),
  line({ t: "tool_result", at: 170, id: "c2", tool: "shell", error: "exit code 2" }),
].join("");
const resultLine = (stdout: string, exit = 0) =>
  line({ t: "result", at: 200, exit, stdout, stderr: "" });

// Real outputs captured from fx 0.0.16 on Nov 12, 2026 (trimmed).
const OK =
  '{"output":"I\'ll create it.\\n\\nCreated `hello.py`","final_output":"Created `hello.py`","exit_code":0,' +
  '"model":"deepseek/deepseek-v4.1-flash","session_id":"fZYuttw1SZHl","steps":4,' +
  '"tool_calls":[{"name":"write_file","status":"success"},{"name":"shell","status":"success"}],' +
  '"usage":{"input_tokens":31748,"output_tokens":331,"cache_read_tokens":30464}}';
const AUTH_FAIL =
  '{"output":"AI_GATEWAY_API_KEY authentication failed · HTTP 401\\n","final_output":"","exit_code":1,' +
  '"session_id":"5QwaUaQ2yAxp","steps":0,"tool_calls":[],"usage":{"input_tokens":null,"output_tokens":null},' +
  '"auth_failure":{"source":"AI_GATEWAY_API_KEY","reason":"http_unauthorized","http_status":401}}';

describe("fx adapter", () => {
  it("builds the command, resuming when a harness session exists", () => {
    expect(buildFxArgs({ input: "-x", model: "m" })).toEqual([
      "env",
      "NODE_USE_ENV_PROXY=1",
      "node",
      "/opt/agent-sandbox/fx-turn.mjs",
      "--json",
      "--no-color",
      "--full-access",
      "--model",
      "m",
      "--",
      "-x",
    ]);
    expect(buildFxArgs({ input: "hi", model: "m", harnessSessionId: "abc" })).toContain("--resume");
  });

  it("maps a successful turn", () => {
    const r = parseFxResult(OK, "", 0);
    expect(r.status).toBe("completed");
    expect(r.outputText).toBe("Created `hello.py`");
    expect(r.harnessSessionId).toBe("fZYuttw1SZHl");
    expect(r.usage).toEqual({ inputTokens: 31748, outputTokens: 331 });
    expect(r.toolCalls.map((t) => t.name)).toEqual(["write_file", "shell"]);
  });

  it("maps an auth failure to a failed turn", () => {
    const r = parseFxResult(AUTH_FAIL, "", 1);
    expect(r.status).toBe("failed");
    expect(r.error?.code).toBe("model_auth_failed");
    expect(r.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it("fails cleanly on non-JSON output", () => {
    const r = parseFxResult("", "gateway relay did not start", 70);
    expect(r.status).toBe("failed");
    expect(r.error?.message).toContain("relay did not start");
  });
});

describe("fx turn parser", () => {
  const run = (text: string, chunkSize: number) => {
    const events: TurnEvent[] = [];
    const parser = new FxTurnParser((e) => events.push(e));
    // Lines arrive split at arbitrary points, as sbx exec delivers them.
    for (let i = 0; i < text.length; i += chunkSize) parser.push(text.slice(i, i + chunkSize));
    return { events, result: parser.finish(0, "") };
  };

  it("maps model parts and tool results to the public events, in order", () => {
    const { events, result } = run(TURN_LINES + resultLine(OK), 7);
    expect(events.map((e) => e.event)).toEqual([
      "response.reasoning.delta",
      "response.output_text.delta",
      "response.tool_call.generating",
      "response.tool_call.started",
      "response.tool_call.completed",
      "response.tool_call.started",
      "response.tool_call.failed",
    ]);
    expect(events[3]?.data).toMatchObject({
      tool: "write_file",
      label: "/home/agent/hello.py",
    });
    const started = events[3]?.data as unknown as { arguments: { content: string } };
    expect(started.arguments.content.length).toBeLessThan(250); // long strings clipped
    expect(events[4]?.data).toEqual({ tool: "write_file", duration_ms: 20 });
    expect(events[6]?.data).toEqual({ tool: "shell", error: "exit code 2" });
    expect(result.status).toBe("completed");
    expect(result.harnessSessionId).toBe("fZYuttw1SZHl");
  });

  it("gives the same events however stdout is chunked", () => {
    const whole = run(TURN_LINES + resultLine(OK), 100_000).events;
    expect(run(TURN_LINES + resultLine(OK), 1).events).toEqual(whole);
  });

  it("closes tool calls that never got a result", () => {
    const unfinished = line({
      t: "part",
      at: 1,
      part: { type: "tool-call", toolCallId: "z", toolName: "shell", input: "{}" },
    });
    const { events, result } = run(unfinished + resultLine(AUTH_FAIL, 1), 50);
    expect(result.status).toBe("failed");
    expect(events.at(-1)).toEqual({
      event: "response.tool_call.failed",
      data: { tool: "shell", error: "The turn ended before the tool finished" },
    });
  });

  it("fails cleanly when the script dies without a result line", () => {
    const parser = new FxTurnParser();
    parser.push("not json\n");
    const r = parser.finish(1, "node: cannot find module");
    expect(r.status).toBe("failed");
    expect(r.error?.message).toContain("cannot find module");
  });
});
