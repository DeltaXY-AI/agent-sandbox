// Which kind of request a Host header names (SPEC section 3, routing):
//   sb-abc123.localhost        -> Agent API of instance sb-abc123
//   sb-abc123-8080.localhost   -> preview URL: port 8080 inside it (needs a credential)
//   anything-else.localhost    -> maybe a public port ({prefix}-{id} or a random slug)
//   localhost                  -> Sandbox API
export type HostRoute =
  | { kind: "api" }
  | { kind: "agent"; id: string }
  | { kind: "preview"; id: string; port: number }
  | { kind: "public"; label: string };

/** The first DNS label of a Host header, lowercased, without the port. */
export function firstLabel(host: string | undefined): { label: string; isSubdomain: boolean } {
  const name = (host ?? "").toLowerCase().split(":")[0] ?? "";
  const [label = "", ...rest] = name.split(".");
  return { label, isSubdomain: rest.length > 0 };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function parseHost(host: string | undefined, prefix: string): HostRoute {
  const { label, isSubdomain } = firstLabel(host);
  if (!isSubdomain || !label) return { kind: "api" };
  const id = `${escape(prefix)}[0-9a-f]+`;
  if (new RegExp(`^${id}$`).test(label)) return { kind: "agent", id: label };
  const preview = new RegExp(`^(${id})-(\\d{1,5})$`).exec(label);
  if (preview?.[1] && preview[2]) {
    const port = Number(preview[2]);
    if (port >= 1 && port <= 65_535) return { kind: "preview", id: preview[1], port };
  }
  return { kind: "public", label };
}
