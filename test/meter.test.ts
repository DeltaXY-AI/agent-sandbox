import { describe, expect, it } from "vitest";
import { usageWindow } from "../src/api/usage.ts";
import { computeUsage } from "../src/meter/meter.ts";
import type { InstanceEvent, TurnUsage } from "../src/store/store.ts";

const T = (iso: string) => Date.parse(iso);
const ev = (id: string, state: string, at: string): InstanceEvent => ({
  instance_id: id,
  workspace_id: "ws",
  state,
  at_ms: T(at),
});
const turn = (id: string, at: string, inp: number, out: number, model = "m"): TurnUsage => ({
  instance_id: id,
  workspace_id: "ws",
  response_id: `r-${at}`,
  model,
  input_tokens: inp,
  output_tokens: out,
  at_ms: T(at),
});

describe("computeUsage", () => {
  const day1 = T("2026-11-12T00:00:00Z");
  const day3 = T("2026-11-14T00:00:00Z");

  it("splits awake and sleeping time by state, open interval running until now", () => {
    const events = [
      ev("a", "provisioning", "2026-11-12T10:00:00Z"),
      ev("a", "running", "2026-11-12T10:00:30Z"),
      ev("a", "stopping", "2026-11-12T10:10:00Z"),
      ev("a", "sleeping", "2026-11-12T10:10:30Z"),
      ev("a", "waking", "2026-11-12T10:40:00Z"),
      ev("a", "running", "2026-11-12T10:40:30Z"),
    ];
    const r = computeUsage(events, [], day1, day3, T("2026-11-12T10:50:30Z"));
    // awake: 10:00-10:10:30 (10.5 min) + 10:40:30-10:50:30 (10 min); sleeping: 10:10:30-10:40:30
    expect(r.instances).toEqual([
      expect.objectContaining({ id: "a", awake_minutes: 20.5, sleeping_minutes: 30 }),
    ]);
    expect(r.totals).toMatchObject({ awake_minutes: 20.5, sleeping_minutes: 30 });
  });

  it("splits an interval at UTC midnight and counts state set before the window", () => {
    const events = [ev("a", "running", "2026-11-11T23:00:00Z")];
    const r = computeUsage(events, [], day1, day3, T("2026-11-13T01:00:00Z"));
    expect(r.days.map((d) => [d.date, d.awake_minutes])).toEqual([
      ["2026-11-12", 1440],
      ["2026-11-13", 60],
    ]);
  });

  it("stops counting at deletion, and failed time is not billed", () => {
    const events = [
      ev("a", "running", "2026-11-12T10:00:00Z"),
      ev("a", "deleted", "2026-11-12T10:05:00Z"),
      ev("b", "running", "2026-11-12T10:00:00Z"),
      ev("b", "failed", "2026-11-12T10:01:00Z"),
    ];
    const r = computeUsage(events, [], day1, day3, T("2026-11-13T00:00:00Z"));
    expect(r.instances.find((i) => i.id === "a")?.awake_minutes).toBe(5);
    expect(r.instances.find((i) => i.id === "b")?.awake_minutes).toBe(1);
  });

  it("sums tokens per instance, day and model", () => {
    const turns = [
      turn("a", "2026-11-12T10:00:00Z", 100, 10, "m1"),
      turn("a", "2026-11-13T10:00:00Z", 200, 20, "m1"),
      turn("b", "2026-11-13T11:00:00Z", 50, 5, "m2"),
    ];
    const r = computeUsage([], turns, day1, day3, day3);
    expect(r.totals).toMatchObject({ turns: 3, input_tokens: 350, output_tokens: 35 });
    expect(r.instances.find((i) => i.id === "a")).toMatchObject({ turns: 2, input_tokens: 300 });
    expect(r.days[1]).toMatchObject({ date: "2026-11-13", turns: 2, input_tokens: 250 });
    expect(r.by_model).toEqual([
      { model: "m1", turns: 2, input_tokens: 300, output_tokens: 30 },
      { model: "m2", turns: 1, input_tokens: 50, output_tokens: 5 },
    ]);
  });
});

describe("usageWindow", () => {
  const now = T("2026-11-12T15:00:00Z");
  it("defaults to the last 30 days up to today, to inclusive", () => {
    const w = usageWindow(undefined, undefined, now);
    expect([w.from, w.to]).toEqual(["2026-10-14", "2026-11-12"]);
    expect(w.toMs).toBe(T("2026-11-13T00:00:00Z"));
  });
  it("rejects bad dates, reversed windows and more than 90 days", () => {
    expect(() => usageWindow("2026-11-xx", undefined, now)).toThrow(/YYYY-MM-DD/);
    expect(() => usageWindow("2026-11-13", "2026-11-12", now)).toThrow(/after/);
    expect(() => usageWindow("2026-01-01", "2026-11-12", now)).toThrow(/90 days/);
  });
});
