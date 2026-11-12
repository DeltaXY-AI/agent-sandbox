import { describe, expect, it } from "vitest";
import { buildFxArgs, parseFxResult } from "../src/harnesses/fx.ts";

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
      "/opt/agent-sandbox/fx-turn.sh",
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
