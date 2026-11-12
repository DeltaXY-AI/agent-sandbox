// Platform templates. A template optionally names the harness that runs agent turns in it.

export const FX_VERSION = "0.0.16";
/** Bump when templates/fx/ changes, so a rebuilt template never hides behind an old tag. */
export const FX_TEMPLATE_REVISION = 2;
export const FX_TEMPLATE_TAG = `agent-sandbox-fx:${FX_VERSION}-r${FX_TEMPLATE_REVISION}`;

export const PI_VERSION = "1.5.2";
/** Bump when the pi template build changes. */
export const PI_TEMPLATE_REVISION = 1;
export const PI_TEMPLATE_TAG = `agent-sandbox-pi:${PI_VERSION}-r${PI_TEMPLATE_REVISION}`;

export interface TemplateDef {
  /** Harness for /v1/responses. Absent: exec only. */
  harness?: string;
}

export const TEMPLATES: Record<string, TemplateDef> = {
  base: {},
  fx: { harness: "fx" },
  pi: { harness: "pi" },
};
