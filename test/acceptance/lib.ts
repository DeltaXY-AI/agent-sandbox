// Shared by the acceptance scripts: HTTP to the control plane, SSE frames, PASS/FAIL.
import { request } from "node:http";
import { EVENT_NAMES } from "../../src/events/types.ts";

export const PORT = Number(process.env.PORT ?? 3000);
export const TEMPLATE = process.env.TEMPLATE ?? "fx";
export const key = process.env.AGENT_SANDBOX_API_KEY;
if (!key) throw new Error("AGENT_SANDBOX_API_KEY not set (use --env-file=.env)");

let failures = 0;
export const failed = () => failures;
export function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
}

export interface Frame {
  id: number;
  event: string;
  data: any;
}

/** Connect to 127.0.0.1 and set Host: Node cannot resolve {id}.localhost on Windows. */
export function call(
  method: string,
  host: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
  opts: { onFrame?: (f: Frame) => boolean | void } = {},
): Promise<{ status: number; text: string; headers: Record<string, unknown>; frames: Frame[] }> {
  const data = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const frames: Frame[] = [];
    const req = request(
      {
        host: "127.0.0.1",
        port: PORT,
        method,
        path,
        headers: {
          host: `${host}:${PORT}`,
          ...(data ? { "content-type": "application/json" } : {}),
          ...headers,
        },
      },
      (res) => {
        let text = "";
        let pending = "";
        const done = () =>
          resolve({ status: res.statusCode ?? 0, text, headers: res.headers, frames });
        res.setEncoding("utf8").on("data", (chunk: string) => {
          text += chunk;
          if (!String(res.headers["content-type"]).startsWith("text/event-stream")) return;
          pending += chunk;
          let end;
          while ((end = pending.indexOf("\n\n")) !== -1) {
            const raw = pending.slice(0, end);
            pending = pending.slice(end + 2);
            if (raw.startsWith(":")) continue; // keepalive
            const f: Partial<Frame> = {};
            for (const line of raw.split("\n")) {
              if (line.startsWith("id: ")) f.id = Number(line.slice(4));
              else if (line.startsWith("event: ")) f.event = line.slice(7);
              else if (line.startsWith("data: ")) f.data = JSON.parse(line.slice(6));
            }
            frames.push(f as Frame);
            if (opts.onFrame?.(f as Frame) === false) {
              req.destroy(); // client disconnects
              done();
              return;
            }
          }
        });
        res.on("end", done);
        res.on("error", () => done());
      },
    );
    req.on("error", (err) => (req.destroyed ? undefined : reject(err)));
    req.setTimeout(10 * 60_000, () => req.destroy(new Error(`${method} ${path} timed out`)));
    req.end(data);
  });
}

export const api = (method: string, path: string, body?: unknown) =>
  call(method, "localhost", path, { authorization: `Bearer ${key}` }, body).then((r) => ({
    ...r,
    json: r.text ? JSON.parse(r.text) : null,
  }));

/** Every frame is one of the 9 events, ids run 1..n, created first, exactly one terminal last. */
export function wellFormed(frames: Frame[]): string {
  if (frames.length === 0) return "no events";
  const bad = frames.find((f) => !EVENT_NAMES.includes(f.event as never));
  if (bad) return `unknown event ${bad.event}`;
  const gap = frames.findIndex((f, i) => f.id !== i + 1);
  if (gap !== -1) return `id ${frames[gap]?.id} at position ${gap + 1}`;
  if (frames[0]?.event !== "response.created") return `first event ${frames[0]?.event}`;
  const terminals = frames.filter((f) => /response\.(completed|failed)$/.test(f.event));
  if (terminals.length !== 1) return `${terminals.length} terminal events`;
  if (frames.at(-1) !== terminals[0]) return "terminal event is not last";
  return "";
}

export const counts = (frames: Frame[]) =>
  Object.entries(
    frames.reduce<Record<string, number>>((m, f) => ((m[f.event] = (m[f.event] ?? 0) + 1), m), {}),
  )
    .map(([k, v]) => `${k.replace("response.", "")}=${v}`)
    .join(" ");
