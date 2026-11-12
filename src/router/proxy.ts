// HTTP proxy from the router to a port inside a sandbox. Streams both directions.
// WebSocket upgrades are not handled yet (SPEC: after acceptance step 6).

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

export class UpstreamUnavailable extends Error {}

export interface ProxyOptions {
  /** Request headers the sandbox must not see (our credentials). */
  dropHeaders?: string[];
  /** Query parameters to strip (a signed-URL token). */
  dropParams?: string[];
  /** Cookies to strip by name. */
  dropCookies?: string[];
}

export async function proxyRequest(
  req: Request,
  target: { host: string; port: number },
  options: ProxyOptions = {},
): Promise<Response> {
  const incoming = new URL(req.url);
  for (const p of options.dropParams ?? []) incoming.searchParams.delete(p);
  const url = `http://${target.host}:${target.port}${incoming.pathname}${incoming.search}`;

  const headers = new Headers();
  const drop = new Set((options.dropHeaders ?? []).map((h) => h.toLowerCase()));
  req.headers.forEach((value, name) => {
    if (!HOP_BY_HOP.has(name) && !drop.has(name)) headers.set(name, value);
  });
  const cookie = headers.get("cookie");
  if (cookie && options.dropCookies?.length) {
    const kept = cookie
      .split(";")
      .map((c) => c.trim())
      .filter((c) => c && !options.dropCookies?.includes(c.split("=")[0] ?? ""));
    if (kept.length) headers.set("cookie", kept.join("; "));
    else headers.delete("cookie");
  }
  const originalHost = req.headers.get("host");
  if (originalHost) headers.set("x-forwarded-host", originalHost);
  headers.set("x-forwarded-proto", incoming.protocol.replace(":", ""));

  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: req.method,
      headers,
      body: hasBody ? req.body : undefined,
      redirect: "manual",
      // @ts-expect-error Node's fetch needs duplex for a streamed request body.
      duplex: hasBody ? "half" : undefined,
    });
  } catch (err) {
    throw new UpstreamUnavailable(`Nothing answered on port ${target.port}: ${String(err)}`);
  }

  const out = new Headers();
  upstream.headers.forEach((value, name) => {
    // fetch already decoded the body, so the encoding and length no longer apply.
    if (!HOP_BY_HOP.has(name) && name !== "content-encoding") out.append(name, value);
  });
  return new Response(upstream.body, { status: upstream.status, headers: out });
}
