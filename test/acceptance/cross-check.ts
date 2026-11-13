// Acceptance step 11 (docs/TESTING.md): the same prompt on fx, Pi and eve. Event names and
// field shapes are identical (src/events/schema.ts) and all three produce a working hello.py.
// Run:  node --env-file=.env test/acceptance/cross-check.ts       (server must be running)
// Env:  TEMPLATES (default fx,pi,eve), PORT (default 3000), AGENT_SANDBOX_API_KEY
// Costs a few model tokens. Prints PASS/FAIL per check; exit code 1 if any check fails.
import { crossCheck } from "../../src/events/schema.ts";
import { api, call, check, counts, failed, wellFormed, type Frame } from "./lib.ts";

const TEMPLATES = (process.env.TEMPLATES ?? "fx,pi,eve").split(",").map((t) => t.trim());
const PROMPT = "write hello.py that prints hello, then run it";
const started = Date.now();
const secs = (t: number) => `${((Date.now() - t) / 1000).toFixed(1)}s`;

interface Run {
  template: string;
  id?: string;
  agentKey?: string;
  frames: Frame[];
  status: number;
  seconds: string;
  error?: string;
}

/** Create one instance, wait for health, send the prompt streamed. */
async function runOne(template: string): Promise<Run> {
  const run: Run = { template, frames: [], status: 0, seconds: "" };
  const t = Date.now();
  const created = await api("POST", "/v1/instances", { template });
  run.id = created.json?.id;
  run.agentKey = created.json?.agent_key;
  if (created.status !== 201 || !run.id) {
    run.error = `create -> ${created.status} ${created.text.slice(0, 120)}`;
    return run;
  }
  const agent = (method: string, path: string, body?: unknown) =>
    call(method, `${run.id}.localhost`, path, { "x-agent-key": run.agentKey ?? "" }, body);
  let healthy = false;
  for (let w = Date.now(); !healthy && Date.now() - w < 180_000;) {
    healthy = JSON.parse((await agent("GET", "/v1/health")).text || "{}").healthy === true;
    if (!healthy) await new Promise((r) => setTimeout(r, 500));
  }
  if (!healthy) {
    run.error = "never healthy";
    return run;
  }
  const turn = await agent("POST", "/v1/responses", { input: PROMPT, stream: true });
  run.frames = turn.frames;
  run.status = turn.status;
  run.seconds = secs(t);
  return run;
}

console.log(`== step 11: cross-check on ${TEMPLATES.join(", ")}: "${PROMPT}"`);
const runs = await Promise.all(TEMPLATES.map(runOne));
try {
  for (const run of runs) {
    console.log(`\n-- ${run.template} (${run.id ?? "no instance"})`);
    if (run.error) {
      check(`${run.template}: instance ready and turn sent`, false, run.error);
      continue;
    }
    const shape = wellFormed(run.frames);
    check(
      `${run.template}: only the 9 events, ids 1..n, created first, one terminal last`,
      run.status === 200 && shape === "",
      shape || counts(run.frames),
    );
    check(
      `${run.template}: ends in response.completed`,
      run.frames.at(-1)?.event === "response.completed",
      run.seconds,
    );
    const hello = await api("POST", `/v1/instances/${run.id}/exec`, {
      command: "cd /home/agent && python3 hello.py",
    });
    check(
      `${run.template}: python3 hello.py prints hello`,
      hello.json?.exit_code === 0 && hello.json?.stdout?.trim() === "hello",
      `exit ${hello.json?.exit_code} ${JSON.stringify(hello.json?.stdout ?? hello.text.slice(0, 80))}`,
    );
  }

  console.log("\n-- event names and field shapes");
  const ready = runs.filter((r) => !r.error);
  const result = crossCheck(
    Object.fromEntries(
      ready.map((r) => [r.template, r.frames.map((f) => ({ event: f.event, data: f.data }))]),
    ),
  );
  // One row per event: which templates sent it, and the shapes they sent.
  for (const [event, byTemplate] of Object.entries(result.shapes)) {
    const senders = TEMPLATES.map((t) => (byTemplate[t] ? t : "-")).join(" ");
    const distinct = [...new Set(Object.values(byTemplate).flat())];
    console.log(
      `  ${event.replace("response.", "").padEnd(22)} ${senders.padEnd(12)} ${distinct.join(" | ")}`,
    );
  }
  check(
    `all ${ready.length} templates send the core events, every payload matches the spec, shapes are identical`,
    ready.length === TEMPLATES.length && result.problems.length === 0,
    result.problems.join("; "),
  );
  const toolNames = ready.map(
    (r) =>
      `${r.template}: ${[
        ...new Set(
          r.frames.filter((f) => f.event === "response.tool_call.started").map((f) => f.data.tool),
        ),
      ].join(", ")}`,
  );
  console.log(`  tool names (values, not compared): ${toolNames.join("; ")}`);
} finally {
  for (const run of runs) {
    if (!run.id) continue;
    const del = await api("DELETE", `/v1/instances/${run.id}`);
    console.log(`cleanup: DELETE ${run.id} (${run.template}) -> ${del.status}`);
  }
}

console.log(
  failed() === 0
    ? `\nCROSS-CHECK PASSED on ${TEMPLATES.join(", ")} (${secs(started)})`
    : `\n${failed()} CHECK(S) FAILED`,
);
process.exit(failed() === 0 ? 0 : 1);
