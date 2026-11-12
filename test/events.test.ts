import { describe, expect, it } from "vitest";
import { ResponseBuffer, ResponseStore } from "../src/events/buffer.ts";
import { formatEvent, parseLastEventId, sseResponse } from "../src/events/sse.ts";
import type { ResponseEvent } from "../src/events/types.ts";

const created: ResponseEvent = { event: "response.created", data: { id: "r", session_id: "s" } };
const delta = (text: string): ResponseEvent => ({
  event: "response.output_text.delta",
  data: { text },
});
const completed: ResponseEvent = {
  event: "response.completed",
  data: { output_text: "ab", usage: null, context: null, reasoning_effort: null },
};

async function readAll(res: Response): Promise<string> {
  return await res.text();
}

describe("response buffer", () => {
  it("numbers events from 1 and stops after the terminal event", () => {
    const b = new ResponseBuffer("r", "s");
    b.push(created);
    b.push(delta("a"));
    b.push(completed);
    expect(b.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(b.done).toBe(true);
    expect(() => b.push(delta("late"))).toThrow();
  });

  it("follow replays after a sequence number, then delivers live, with no gap or duplicate", () => {
    const b = new ResponseBuffer("r", "s");
    b.push(created);
    b.push(delta("a"));
    const seen: number[] = [];
    b.follow(1, (e) => seen.push(e.seq));
    b.push(delta("b"));
    b.push(completed);
    expect(seen).toEqual([2, 3, 4]);
  });

  it("store drops finished responses after the retention time", async () => {
    const store = new ResponseStore(5);
    const b = store.create("r", "s");
    b.push(created);
    b.push(completed);
    expect(store.get("r")).toBe(b);
    await new Promise((r) => setTimeout(r, 20));
    expect(store.get("r")).toBeUndefined();
  });
});

describe("sse writer", () => {
  it("formats id, event and data lines", () => {
    expect(formatEvent({ seq: 3, event: delta("hi") })).toBe(
      'id: 3\nevent: response.output_text.delta\ndata: {"text":"hi"}\n\n',
    );
  });

  it("parses Last-Event-ID, treating junk as the start", () => {
    expect(parseLastEventId("7")).toBe(7);
    expect(parseLastEventId(undefined)).toBe(0);
    expect(parseLastEventId("abc")).toBe(0);
    expect(parseLastEventId("-2")).toBe(0);
  });

  it("streams live events and closes after the terminal event", async () => {
    const b = new ResponseBuffer("r", "s");
    b.push(created);
    const res = sseResponse(b);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = readAll(res);
    b.push(delta("a"));
    b.push(completed);
    const body = await text;
    expect(body.match(/^event: .*$/gm)).toEqual([
      "event: response.created",
      "event: response.output_text.delta",
      "event: response.completed",
    ]);
  });

  it("replays only what comes after Last-Event-ID on a finished response", async () => {
    const b = new ResponseBuffer("r", "s");
    b.push(created);
    b.push(delta("a"));
    b.push(completed);
    expect((await readAll(sseResponse(b, 2))).match(/^id: \d+$/gm)).toEqual(["id: 3"]);
    expect(await readAll(sseResponse(b, 3))).toBe("");
  });

  it("writes :keepalive comments while waiting", async () => {
    const b = new ResponseBuffer("r", "s");
    b.push(created);
    const text = readAll(sseResponse(b, 1, 5));
    await new Promise((r) => setTimeout(r, 30));
    b.push(completed);
    expect(await text).toContain(":keepalive\n\n");
  });
});
