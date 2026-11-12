// Shared by harness adapters: turn a tool call's input into the `arguments` and `label`
// of response.tool_call.started (Agent37: arguments as an object, long strings clipped;
// label is a one-line summary).

const MAX_ARG_CHARS = 200;

/** Tool input arrives as an object or a JSON string. Long strings are clipped. */
export function toolArguments(input: unknown): Record<string, unknown> | undefined {
  let value = input;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] =
      typeof v === "string" && v.length > MAX_ARG_CHARS ? `${v.slice(0, MAX_ARG_CHARS)}...` : v;
  }
  return out;
}

/** One-line summary of a tool call for `label`: the command, path or query it acts on. */
export function toolLabel(args: Record<string, unknown> | undefined): string | undefined {
  for (const key of ["command", "path", "pattern", "query", "url"]) {
    const v = args?.[key];
    if (typeof v === "string" && v) return v.split("\n")[0]?.slice(0, 120);
  }
  return undefined;
}

/** The `data` of response.tool_call.started for a tool and its raw input. */
export function startedData(tool: string, input: unknown) {
  const args = toolArguments(input);
  const data: { tool: string; label?: string; arguments?: Record<string, unknown> } = { tool };
  const label = toolLabel(args);
  if (label) data.label = label;
  if (args) data.arguments = args;
  return data;
}
