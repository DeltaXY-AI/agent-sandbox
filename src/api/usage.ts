// GET /v1/usage?from=YYYY-MM-DD&to=YYYY-MM-DD: the caller's workspace usage (SPEC section 3).
// Dates are UTC, `to` inclusive; defaults: to = today, from = 30 days before; at most 90 days.
import { Hono } from "hono";
import { ApiError } from "../instances/service.ts";
import type { Meter } from "../meter/meter.ts";

const DAY_MS = 86_400_000;
const MAX_DAYS = 90;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Validate a from/to pair and turn it into a millisecond window [fromMs, toMs). */
export function usageWindow(fromParam?: string, toParam?: string, now = Date.now()) {
  const to = toParam ?? new Date(now).toISOString().slice(0, 10);
  const toStart = Date.parse(`${to}T00:00:00Z`);
  if (!DATE.test(to) || Number.isNaN(toStart)) {
    throw new ApiError(400, "validation_error", "to must be YYYY-MM-DD");
  }
  const from = fromParam ?? new Date(toStart - 29 * DAY_MS).toISOString().slice(0, 10);
  const fromMs = Date.parse(`${from}T00:00:00Z`);
  if (!DATE.test(from) || Number.isNaN(fromMs)) {
    throw new ApiError(400, "validation_error", "from must be YYYY-MM-DD");
  }
  if (fromMs > toStart) throw new ApiError(400, "validation_error", "from is after to");
  if ((toStart - fromMs) / DAY_MS + 1 > MAX_DAYS) {
    throw new ApiError(400, "validation_error", `At most ${MAX_DAYS} days`);
  }
  return { from, to, fromMs, toMs: toStart + DAY_MS };
}

export function usageRoutes(meter: Meter) {
  // workspaceId is set by the API-key middleware in app.ts.
  const app = new Hono<{ Variables: { workspaceId: string } }>();
  app.get("/", (c) => {
    const { from, to } = usageWindow(c.req.query("from"), c.req.query("to"));
    return c.json(meter.usage(c.get("workspaceId"), from, to));
  });
  return app;
}
