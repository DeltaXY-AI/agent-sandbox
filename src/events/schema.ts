// The payload of each public event as data, so streams can be checked at run time:
// acceptance step 11 (the cross-check) and the adapters' unit tests (SPEC section 3, 7).
import type { EventName } from "./types.ts";

/** A field's type. A record describes a nested object field by field; an array is a union. */
type FieldType = "string" | "number" | "object" | "null" | FieldRecord | FieldType[];
interface FieldRecord {
  [key: string]: FieldType;
}

interface EventSchema {
  required: FieldRecord;
  optional?: FieldRecord;
}

const USAGE: FieldRecord = { input_tokens: "number", output_tokens: "number" };

/** Mirrors the types in types.ts (Agent37's streaming payloads). */
export const EVENT_SCHEMA: Record<EventName, EventSchema> = {
  "response.created": { required: { id: "string", session_id: "string" } },
  "response.reasoning.delta": { required: { text: "string" } },
  "response.output_text.delta": { required: { text: "string" } },
  "response.tool_call.generating": { required: { tool: "string" } },
  "response.tool_call.started": {
    required: { tool: "string" },
    optional: { label: "string", arguments: "object" },
  },
  "response.tool_call.completed": {
    required: { tool: "string" },
    optional: { duration_ms: "number" },
  },
  "response.tool_call.failed": { required: { tool: "string" }, optional: { error: "string" } },
  "response.completed": {
    required: {
      output_text: "string",
      usage: [USAGE, "null"],
      context: "null",
      reasoning_effort: ["string", "null"],
    },
  },
  "response.failed": { required: { error: { code: "string", message: "string" } } },
};

/** Events every harness emits on a turn that writes and runs a file (step 11). */
export const CORE_EVENTS: readonly EventName[] = [
  "response.created",
  "response.output_text.delta",
  "response.tool_call.generating",
  "response.tool_call.started",
  "response.tool_call.completed",
  "response.completed",
];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/** Problems with `value` against `type`, each prefixed with its path. */
function checkField(path: string, value: unknown, type: FieldType): string[] {
  if (Array.isArray(type)) {
    const results = type.map((t) => checkField(path, value, t));
    return results.some((r) => r.length === 0) ? [] : (results[0] ?? []);
  }
  if (typeof type === "string") {
    if (type === "object")
      return isRecord(value) ? [] : [`${path}: ${typeName(value)}, want object`];
    return typeName(value) === type ? [] : [`${path}: ${typeName(value)}, want ${type}`];
  }
  if (!isRecord(value)) return [`${path}: ${typeName(value)}, want object`];
  return checkRecord(path, value, { required: type });
}

function checkRecord(path: string, data: Record<string, unknown>, schema: EventSchema): string[] {
  const problems: string[] = [];
  const optional = schema.optional ?? {};
  for (const [key, type] of Object.entries(schema.required)) {
    if (!(key in data)) problems.push(`${path}.${key}: missing`);
    else problems.push(...checkField(`${path}.${key}`, data[key], type));
  }
  for (const [key, value] of Object.entries(data)) {
    if (key in schema.required) continue;
    const type = optional[key];
    if (type === undefined) problems.push(`${path}.${key}: not in the spec`);
    else problems.push(...checkField(`${path}.${key}`, value, type));
  }
  return problems;
}

/** Problems with one event against the spec; empty when it conforms. */
export function checkEvent(event: string, data: unknown): string[] {
  const schema = EVENT_SCHEMA[event as EventName];
  if (!schema) return [`${event}: not one of the 9 events`];
  if (!isRecord(data)) return [`${event}: data is ${typeName(data)}, want object`];
  return checkRecord(event, data, schema);
}

/**
 * An event's field shape: its keys and their types, nested where the spec nests
 * (`usage`, `error`), e.g. `{arguments:object,label:string,tool:string}`. Values are ignored.
 */
export function shapeOf(event: string, data: unknown): string {
  const schema = EVENT_SCHEMA[event as EventName];
  const fields: FieldRecord = { ...schema?.optional, ...schema?.required };
  return shapeWith(data, fields);
}

function shapeWith(value: unknown, fields: FieldRecord | undefined): string {
  if (!isRecord(value)) return typeName(value);
  const parts = Object.keys(value)
    .sort()
    .map((key) => {
      const v = value[key];
      const declared = fields?.[key];
      const nested = Array.isArray(declared)
        ? declared.find((t): t is FieldRecord => typeof t === "object" && !Array.isArray(t))
        : typeof declared === "object"
          ? declared
          : undefined;
      // Free-form objects (`arguments`) count as "object"; declared records are compared inside.
      return `${key}:${nested && isRecord(v) ? shapeWith(v, nested) : isRecord(v) ? "object" : typeName(v)}`;
    });
  return `{${parts.join(",")}}`;
}

export interface CrossCheck {
  /** Event name -> template -> the distinct shapes it sent. */
  shapes: Record<string, Record<string, string[]>>;
  problems: string[];
}

/**
 * Step 11: every event conforms to the spec, every template sends the core events, and
 * where two templates send the same event the shapes match exactly (optional fields too).
 * Events only some templates send (reasoning, tool failures) are listed, not required.
 */
export function crossCheck(
  streams: Record<string, { event: string; data: unknown }[]>,
  core: readonly string[] = CORE_EVENTS,
): CrossCheck {
  const problems: string[] = [];
  const shapes: CrossCheck["shapes"] = {};
  for (const [template, events] of Object.entries(streams)) {
    for (const e of events) {
      for (const p of checkEvent(e.event, e.data)) problems.push(`${template}: ${p}`);
      const byTemplate = (shapes[e.event] ??= {});
      const list = (byTemplate[template] ??= []);
      const shape = shapeOf(e.event, e.data);
      if (!list.includes(shape)) list.push(shape);
    }
    const sent = new Set(events.map((e) => e.event));
    for (const name of core) {
      if (!sent.has(name)) problems.push(`${template}: never sent ${name}`);
    }
  }
  for (const [event, byTemplate] of Object.entries(shapes)) {
    const entries = Object.entries(byTemplate).map(([t, s]) => [t, [...s].sort()] as const);
    const [first, ...rest] = entries;
    if (!first) continue;
    for (const [template, list] of rest) {
      if (list.join(" | ") !== first[1].join(" | ")) {
        problems.push(
          `${event}: ${first[0]} sends ${first[1].join(" | ")}, ${template} sends ${list.join(" | ")}`,
        );
      }
    }
  }
  return { shapes, problems };
}
