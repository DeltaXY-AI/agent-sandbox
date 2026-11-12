// Replay buffer: every event of a response, numbered from 1, kept after the turn ends
// so a client can reattach (GET /v1/responses/{id}/stream). SPEC section 3: kept 30 minutes.
import { isTerminal, type ResponseEvent } from "./types.ts";

export interface SequencedEvent {
  seq: number;
  event: ResponseEvent;
}

type Listener = (e: SequencedEvent) => void;

export class ResponseBuffer {
  readonly events: SequencedEvent[] = [];
  private readonly listeners = new Set<Listener>();
  finishedAt: number | undefined;
  readonly id: string;
  readonly sessionId: string;

  constructor(id: string, sessionId: string) {
    this.id = id;
    this.sessionId = sessionId;
  }

  get done(): boolean {
    return this.finishedAt !== undefined;
  }

  push(event: ResponseEvent): void {
    if (this.done) throw new Error(`Response ${this.id} already ended`);
    const e = { seq: this.events.length + 1, event };
    this.events.push(e);
    if (isTerminal(event)) this.finishedAt = Date.now();
    for (const listener of this.listeners) listener(e);
    if (this.done) this.listeners.clear();
  }

  /**
   * Replay events after `afterSeq`, then deliver new ones live. Delivery is synchronous,
   * so nothing is missed or repeated between replay and live. Returns an unsubscribe.
   */
  follow(afterSeq: number, listener: Listener): () => void {
    for (const e of this.events) if (e.seq > afterSeq) listener(e);
    if (this.done) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** Response buffers of one instance, dropped `retentionMs` after their turn ends. */
export class ResponseStore {
  private readonly buffers = new Map<string, ResponseBuffer>();
  private readonly retentionMs: number;

  constructor(retentionMs = 30 * 60_000) {
    this.retentionMs = retentionMs;
  }

  create(id: string, sessionId: string): ResponseBuffer {
    this.prune();
    const buffer = new ResponseBuffer(id, sessionId);
    this.buffers.set(id, buffer);
    return buffer;
  }

  get(id: string): ResponseBuffer | undefined {
    this.prune();
    return this.buffers.get(id);
  }

  private prune(now = Date.now()) {
    for (const [id, b] of this.buffers) {
      if (b.finishedAt !== undefined && now - b.finishedAt > this.retentionMs)
        this.buffers.delete(id);
    }
  }
}
