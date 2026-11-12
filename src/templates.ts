// Platform templates. A template optionally names the harness that runs agent turns in it.

export const FX_VERSION = "0.0.16";
export const FX_TEMPLATE_TAG = `agent-sandbox-fx:${FX_VERSION}`;

export interface TemplateDef {
  /** Harness for /v1/responses. Absent: exec only. */
  harness?: string;
}

export const TEMPLATES: Record<string, TemplateDef> = {
  base: {},
  fx: { harness: "fx" },
};
