import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { TurnEvent } from "../src/events/types.ts";
import { buildEveArgs, EveTurnParser } from "../src/harnesses/eve.ts";

// A real eve-turn.mjs run (eve 1.0.0-rc.10, Nov 12, 2026): write hello.py, then run it.
const FIXTURE = readFileSync("test/fixtures/eve-1.0.0-rc.10-hello-turn.jsonl", "utf8");

function run(text: string, chunkSize: number, exitCode = 0, stderr = "") {
  const events: TurnEvent[] = [];
  const parser = new EveTurnParser((e) => events.push(e));
  for (let i = 0; i < text.length; i += chunkSize) parser.push(text.slice(i, i + chunkSize));
  return { events, result: parser.finish(exitCode, stderr) };
}

const shim = (...lines: object[]) => lines.map((l) => JSON.stringify(l)).join("\n");

describe("eve adapter", () => {
  it("runs the shim with Node 24, continuing the eve session when there is one", () => {
    expect(buildEveArgs({ input: "hi", model: "m" })).toEqual([
      "/opt/node24/bin/node",
      "/opt/agent-sandbox/eve-turn.mjs",
      "hi",
    ]);
    expect(buildEveArgs({ input: "hi", model: "m", harnessSessionId: "wrun_1" }).at(-1)).toBe(
      "wrun_1",
    );
  });

  it("maps a real eve turn to the public events", () => {
    const { events, result } = run(FIXTURE, 4096);
    const tools = events.filter((e) => e.event.startsWith("response.tool_call."));
    expect(
      tools.map((e) => [
        e.event.replace("response.tool_call.", ""),
        (e.data as { tool: string }).tool,
      ]),
    ).toEqual([
      ["generating", "write_file"],
      ["started", "write_file"],
      ["completed", "write_file"],
      ["generating", "bash"],
      ["started", "bash"],
      ["completed", "bash"],
    ]);
    // eve's own one-line labels are used.
    expect(tools[1]?.data).toMatchObject({ label: "Write /home/agent/hello.py" });
    expect(tools[4]?.data).toMatchObject({
      label: "Run cd /home/agent && python3 hello.py",
      arguments: { command: "cd /home/agent && python3 hello.py" },
    });
    // Durations come from the call.started and call.settled timestamps (35 ms and 171 ms).
    expect(tools[2]?.data).toEqual({ tool: "write_file", duration_ms: 35 });
    expect(tools[5]?.data).toEqual({ tool: "bash", duration_ms: 171 });
    expect(events.some((e) => e.event === "response.output_text.delta")).toBe(true);

    expect(result.status).toBe("completed");
    expect(result.harnessSessionId).toBe("wrun_01M789QGR774AS8HRNV6HJJ1AV");
    expect(result.outputText).toBe(
      'Created `/home/agent/hello.py` with `print("hello")` and ran it — output was `hello`.',
    );
    // 3 model runs: 3670+3762+3822 in, 65+47+27 out.
    expect(result.usage).toEqual({ inputTokens: 11254, outputTokens: 139 });
    expect(result.toolCalls).toEqual([
      { name: "write_file", status: "success" },
      { name: "bash", status: "success" },
    ]);
  });

  it("gives the same events however stdout is chunked", () => {
    expect(run(FIXTURE, 1).events).toEqual(run(FIXTURE, 100_000).events);
  });

  it("reasoning parts become reasoning deltas, even after the first delta", () => {
    const { events } = run(
      shim(
        {
          t: "line",
          line: {
            progress: {
              type: "content.delta",
              data: { partId: "p", kind: "reasoning", delta: "a" },
            },
          },
        },
        {
          t: "line",
          line: { progress: { type: "content.delta", data: { partId: "p", delta: "b" } } },
        },
      ),
      9,
    );
    expect(events).toEqual([
      { event: "response.reasoning.delta", data: { text: "a" } },
      { event: "response.reasoning.delta", data: { text: "b" } },
    ]);
  });

  it("a failed tool, a paused turn and a shim error are failures, never hangs", () => {
    const failedTool = run(
      shim(
        { t: "session", id: "s" },
        {
          t: "line",
          line: {
            at: "2026-11-12T00:00:00Z",
            facts: [
              {
                type: "call.requested",
                data: { callId: "c", capability: { name: "bash" }, input: { command: "x" } },
              },
            ],
          },
        },
        {
          t: "line",
          line: {
            at: "2026-11-12T00:00:01Z",
            facts: [
              {
                type: "call.settled",
                data: { callId: "c", outcome: "failed", error: { code: "E", message: "exit 2" } },
              },
            ],
          },
        },
        { t: "end", outcome: "paused" },
      ),
      13,
    );
    expect(failedTool.events.at(-1)).toEqual({
      event: "response.tool_call.failed",
      data: { tool: "bash", error: "exit 2" },
    });
    expect(failedTool.result.status).toBe("failed");
    expect(failedTool.result.error?.message).toMatch(/paused/);

    const shimError = run(shim({ t: "error", message: "eve server did not become healthy" }), 50);
    expect(shimError.result).toMatchObject({
      status: "failed",
      error: { message: "eve server did not become healthy" },
    });
    expect(run("", 1, 1, "node: not found").result.error?.message).toContain("not found");
  });
});
