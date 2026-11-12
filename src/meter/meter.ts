// Meter: awake minutes, sleeping (disk-only) minutes and tokens per instance and per UTC
// day, from recorded state changes and finished turns (SPEC section 2, layer 7; acceptance
// step 10). Response shape follows Agent37's GET /v1/usage without the money fields
// (prices are not decided yet), plus sleeping_minutes, which step 10 asks for.
import type { InstanceEvent, Store, TurnUsage } from "../store/store.ts";

/** Billed at the full rate on Agent37: the VM is using CPU and memory. */
const AWAKE = new Set(["provisioning", "running", "starting", "stopping"]);
/** Billed for disk only: the VM is off, its disk is kept. */
const SLEEPING = new Set(["sleeping", "waking", "stopped"]);

const DAY_MS = 86_400_000;

export interface UsageCounts {
  awake_minutes: number;
  sleeping_minutes: number;
  turns: number;
  input_tokens: number;
  output_tokens: number;
}

export interface UsageReport {
  from: string;
  to: string;
  totals: UsageCounts;
  days: (UsageCounts & { date: string })[];
  instances: (UsageCounts & { id: string })[];
  by_model: { model: string; turns: number; input_tokens: number; output_tokens: number }[];
}

interface Acc {
  awakeMs: number;
  sleepingMs: number;
  turns: number;
  input_tokens: number;
  output_tokens: number;
}
const empty = (): Acc => ({
  awakeMs: 0,
  sleepingMs: 0,
  turns: 0,
  input_tokens: 0,
  output_tokens: 0,
});
const minutes = (ms: number) => Math.round((ms / 60_000) * 100) / 100;
const counts = (a: Acc): UsageCounts => ({
  awake_minutes: minutes(a.awakeMs),
  sleeping_minutes: minutes(a.sleepingMs),
  turns: a.turns,
  input_tokens: a.input_tokens,
  output_tokens: a.output_tokens,
});
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Pure usage arithmetic. `events` may start before `fromMs` (they set the state at the
 * start of the window); the last state of each instance runs until `nowMs`.
 */
export function computeUsage(
  events: InstanceEvent[],
  turns: TurnUsage[],
  fromMs: number,
  toMs: number,
  nowMs: number,
): Omit<UsageReport, "from" | "to"> {
  const byInstance = new Map<string, Acc>();
  const byDay = new Map<string, Acc>();
  const byModel = new Map<string, Acc>();
  const total = empty();
  const acc = <K>(map: Map<K, Acc>, key: K) => {
    let a = map.get(key);
    if (!a) map.set(key, (a = empty()));
    return a;
  };
  for (let d = fromMs; d < toMs; d += DAY_MS) acc(byDay, dayOf(d));

  const perInstance = new Map<string, InstanceEvent[]>();
  for (const e of events) {
    const list = perInstance.get(e.instance_id) ?? [];
    list.push(e);
    perInstance.set(e.instance_id, list);
  }
  const end = Math.min(toMs, nowMs);
  for (const [id, list] of perInstance) {
    for (let i = 0; i < list.length; i++) {
      const e = list[i] as InstanceEvent;
      const kind = AWAKE.has(e.state) ? "awakeMs" : SLEEPING.has(e.state) ? "sleepingMs" : null;
      if (!kind) continue;
      const start = Math.max(e.at_ms, fromMs);
      const stop = Math.min(list[i + 1]?.at_ms ?? end, end);
      // Split at UTC midnight so each day gets its own share.
      for (let t = start; t < stop;) {
        const next = Math.min(stop, Math.floor(t / DAY_MS) * DAY_MS + DAY_MS);
        const ms = next - t;
        acc(byInstance, id)[kind] += ms;
        acc(byDay, dayOf(t))[kind] += ms;
        total[kind] += ms;
        t = next;
      }
    }
  }

  for (const u of turns) {
    for (const a of [
      total,
      acc(byInstance, u.instance_id),
      acc(byDay, dayOf(u.at_ms)),
      acc(byModel, u.model),
    ]) {
      a.turns += 1;
      a.input_tokens += u.input_tokens;
      a.output_tokens += u.output_tokens;
    }
  }

  return {
    totals: counts(total),
    days: [...byDay]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, a]) => ({ date, ...counts(a) })),
    instances: [...byInstance].map(([id, a]) => ({ id, ...counts(a) })),
    by_model: [...byModel].map(([model, a]) => ({
      model,
      turns: a.turns,
      input_tokens: a.input_tokens,
      output_tokens: a.output_tokens,
    })),
  };
}

export class Meter {
  private readonly store: Store;
  private readonly clock: () => number;
  /** Last recorded state per instance, so repeated statuses are not stored twice. */
  private readonly last = new Map<string, string>();

  constructor(store: Store, clock: () => number = Date.now) {
    this.store = store;
    this.clock = clock;
  }

  /** Record that an instance entered `state` (an instance status, or "deleted"). */
  recordState(instanceId: string, workspaceId: string, state: string): void {
    if (this.last.get(instanceId) === state) return;
    this.last.set(instanceId, state);
    this.store.addInstanceEvent({
      instance_id: instanceId,
      workspace_id: workspaceId,
      state,
      at_ms: this.clock(),
    });
  }

  recordTurn(u: Omit<TurnUsage, "at_ms">): void {
    this.store.addTurnUsage({ ...u, at_ms: this.clock() });
  }

  /** Usage for whole UTC days [from, to], to inclusive. */
  usage(workspaceId: string, from: string, to: string): UsageReport {
    const fromMs = Date.parse(`${from}T00:00:00Z`);
    const toMs = Date.parse(`${to}T00:00:00Z`) + DAY_MS;
    const events = this.store.instanceEvents(workspaceId, toMs);
    const turns = this.store.turnUsage(workspaceId, fromMs, toMs);
    return { from, to, ...computeUsage(events, turns, fromMs, toMs, this.clock()) };
  }

  /** State changes of one instance in [fromMs, toMs), for GET /v1/instances/{id}/events. */
  events(workspaceId: string, instanceId: string, fromMs: number, toMs: number) {
    return this.store
      .instanceEvents(workspaceId, toMs, instanceId)
      .filter((e) => e.at_ms >= fromMs)
      .map((e) => ({ type: `instance.${e.state}`, at: new Date(e.at_ms).toISOString() }));
  }
}
