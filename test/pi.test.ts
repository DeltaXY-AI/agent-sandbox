import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { TurnEvent } from "../src/events/types.ts";
import { buildPiArgs, PiTurnParser } from "../src/harnesses/pi.ts";

// A real `pi --mode json` turn (Pi 1.5.2, Nov 12, 2026): write hello.py, then run it.
const FIXTURE = readFileSync("test/fixtures/pi-1.5.2-hello-turn.jsonl", "utf8");

function run(text: string, chunkSize: number, exitCode = 0, stderr = "") {
  const events: TurnEvent[] = [];
  const parser = new PiTurnParser((e) => events.push(e));
  for (let i = 0; i < text.length; i += chunkSize) parser.push(text.slice(i, i + chunkSize));
  return { events, result: parser.finish(exitCode, stderr) };
}

describe("pi adapter", () => {
  it("builds a headless command with stdin closed and the prompt after --", () => {
    const args = buildPiArgs({ input: "-x", model: "deepseek/deepseek-v4.1-flash" }, "s-1");
    expect(args.slice(0, 4)).toEqual(["sh", "-c", 'exec pi "$@" </dev/null', "pi"]);
    expect(args).toContain("--session-id");
    expect(args[args.indexOf("--session-id") + 1]).toBe("s-1");
    expect(args.slice(-2)).toEqual(["--", "-x"]);
  });

  it("maps a real Pi turn to the public events, in order", () => {
    const { events, result } = run(FIXTURE, 4096);
    const names = events.map((e) => e.event);
    expect(new Set(names)).toEqual(
      new Set([
        "response.output_text.delta",
        "response.tool_call.generating",
        "response.tool_call.started",
        "response.tool_call.completed",
      ]),
    );
    const tools = events.filter((e) => e.event.startsWith("response.tool_call."));
    expect(
      tools.map((e) => [
        e.event.replace("response.tool_call.", ""),
        (e.data as { tool: string }).tool,
      ]),
    ).toEqual([
      ["generating", "write"],
      ["started", "write"],
      ["completed", "write"],
      ["generating", "bash"],
      ["started", "bash"],
      ["completed", "bash"],
    ]);
    expect(tools[1]?.data).toMatchObject({ label: "/home/agent/hello.py" });
    expect(tools[4]?.data).toMatchObject({ label: "cd /home/agent && python3 hello.py" });
    expect(tools[5]?.data).toEqual({ tool: "bash", duration_ms: 93 });

    expect(result.status).toBe("completed");
    expect(result.harnessSessionId).toBe("probe-sess-3");
    expect(result.outputText.length).toBeGreaterThan(0);
    // input + cacheRead + cacheWrite over the 3 assistant messages: 1496, 45+1536, 105+1536.
    expect(result.usage).toEqual({ inputTokens: 4718, outputTokens: 130 });
    expect(result.toolCalls).toEqual([
      { name: "write", status: "success" },
      { name: "bash", status: "success" },
    ]);
  });

  it("gives the same events however stdout is chunked", () => {
    expect(run(FIXTURE, 1).events).toEqual(run(FIXTURE, 100_000).events);
  });

  it("a gateway 401 is a failed turn even though Pi exits 0", () => {
    const lines = [
      { type: "session", version: 3, id: "s-2" },
      { type: "agent_start" },
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: '401 {"error":{"message":"Authentication failed."}}',
        },
      },
      { type: "agent_settled", aborted: false },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n");
    const { result } = run(lines, 50, 0);
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("model_auth_failed");
    expect(result.harnessSessionId).toBe("s-2");
  });

  it("a failed tool and a turn that never settles", () => {
    const lines = [
      { type: "tool_execution_start", toolCallId: "c", toolName: "bash", args: { command: "x" } },
      {
        type: "tool_execution_end",
        toolCallId: "c",
        toolName: "bash",
        isError: true,
        result: { content: [{ type: "text", text: "exit code 2" }] },
      },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n");
    const { events, result } = run(lines, 7, 1, "pi: crashed");
    expect(events.at(-1)).toEqual({
      event: "response.tool_call.failed",
      data: { tool: "bash", error: "exit code 2" },
    });
    expect(result.status).toBe("failed");
    expect(result.error?.message).toContain("crashed");
  });
});
