// SSE writer for a ResponseBuffer. Frames: `id: <seq>`, `event: <name>`, `data: <json>`.
// `:keepalive` every 30 s. No [DONE] sentinel: the terminal event plus close ends the stream.
// Reattach sends Last-Event-ID; only events after it are written (no gap, no duplicate).
import type { ResponseBuffer, SequencedEvent } from "./buffer.ts";

export const KEEPALIVE_MS = 30_000;

export function formatEvent(e: SequencedEvent): string {
  return `id: ${e.seq}\nevent: ${e.event.event}\ndata: ${JSON.stringify(e.event.data)}\n\n`;
}

/** Parse a Last-Event-ID header; anything unusable means "from the start". */
export function parseLastEventId(header: string | undefined): number {
  const n = Number(header);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/** A text/event-stream Response that replays `buffer` after `afterSeq`, then follows it live. */
export function sseResponse(buffer: ResponseBuffer, afterSeq = 0, keepaliveMs = KEEPALIVE_MS) {
  const encoder = new TextEncoder();
  let cleanup = () => undefined as void;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        cleanup();
        controller.close();
      };
      const timer = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(":keepalive\n\n"));
      }, keepaliveMs);
      let unsubscribe = () => undefined as unknown;
      cleanup = () => {
        clearInterval(timer);
        unsubscribe();
      };
      unsubscribe = buffer.follow(afterSeq, (e) => {
        if (closed) return;
        controller.enqueue(encoder.encode(formatEvent(e)));
        if (e.event.event === "response.completed" || e.event.event === "response.failed") {
          queueMicrotask(close);
        }
      });
      // Replay of a finished response that has nothing left to send.
      if (buffer.done && (buffer.events.at(-1)?.seq ?? 0) <= afterSeq) queueMicrotask(close);
    },
    // The client went away. The turn keeps running; only this view stops.
    cancel() {
      cleanup();
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    },
  });
}
