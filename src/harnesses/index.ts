import { fxAdapter } from "./fx.ts";
import type { HarnessAdapter } from "./types.ts";

export const HARNESSES: Record<string, HarnessAdapter> = {
  fx: fxAdapter,
};
