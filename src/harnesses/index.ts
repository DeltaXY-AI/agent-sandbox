import { eveAdapter } from "./eve.ts";
import { fxAdapter } from "./fx.ts";
import { piAdapter } from "./pi.ts";
import type { HarnessAdapter } from "./types.ts";

export const HARNESSES: Record<string, HarnessAdapter> = {
  fx: fxAdapter,
  pi: piAdapter,
  eve: eveAdapter,
};
