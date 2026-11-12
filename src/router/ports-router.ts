// Serves preview URLs ({id}-{port}.<domain>) and public ports ({prefix}-{id} or a slug).
// Both wake a sleeping instance, count as activity and proxy to the port inside it.
// Errors follow Agent37: 401 without a credential, 404 unknown, 502 nothing listening,
// 503 unavailable for a stopped instance, 503 wake_timeout.
import { timingSafeEqual } from "node:crypto";
import { ApiError, type InstanceService } from "../instances/service.ts";
import { TOKEN_PARAM, type PublicPorts, type UrlSigner } from "./ports.ts";
import { proxyRequest, UpstreamUnavailable } from "./proxy.ts";

export interface PortsRouterDeps {
  /** The workspace an API key belongs to (undefined: unknown or revoked). */
  workspaceOf: (key: string | undefined) => string | undefined;
  instances: InstanceService;
  publicPorts: PublicPorts;
  signer: UrlSigner;
}

const json = (status: number, code: string, message: string) =>
  Response.json({ error: { code, message } }, { status });

function sameKey(given: string | null | undefined, expected: string | undefined): boolean {
  if (!given || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookieValue(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

export function portsRouter(deps: PortsRouterDeps) {
  /** Wake, hold, proxy; map failures to Agent37's codes. */
  async function forward(req: Request, instanceId: string, port: number, dropHeaders: string[]) {
    try {
      return await deps.instances.use(instanceId, async () => {
        const target = await deps.instances.portAddress(instanceId, port);
        try {
          return await proxyRequest(req, target, {
            dropHeaders,
            dropParams: [TOKEN_PARAM],
            dropCookies: [TOKEN_PARAM],
          });
        } catch (err) {
          // The mapping may be stale (the sandbox restarted); look it up again next time.
          deps.instances.forgetPort(instanceId, port);
          throw err;
        }
      });
    } catch (err) {
      if (err instanceof UpstreamUnavailable) {
        return json(502, "upstream_unavailable", `Nothing is listening on port ${port}`);
      }
      if (err instanceof ApiError) {
        if (err.code === "instance_stopped") return json(503, "unavailable", err.message);
        return json(err.status, err.code, err.message);
      }
      console.error(`proxy to ${instanceId}:${port} failed:`, err);
      return json(502, "upstream_unavailable", "Proxy error");
    }
  }

  /** Preview URL: needs the owning workspace's API key, the agent key, or a signed URL. */
  async function preview(req: Request, instanceId: string, port: number): Promise<Response> {
    let instance;
    try {
      instance = deps.instances.get(instanceId);
    } catch {
      return json(404, "instance_not_found", `No instance ${instanceId}`);
    }
    // Another workspace's key: 404, as on the Sandbox API (Agent37).
    const keyWorkspace = deps.workspaceOf(
      req.headers.get("authorization")?.replace(/^Bearer /, ""),
    );
    if (keyWorkspace && keyWorkspace !== instance.workspace_id) {
      return json(404, "instance_not_found", `No instance ${instanceId}`);
    }
    const bearer = req.headers.get("authorization")?.replace(/^Bearer /, "");
    const queryToken = new URL(req.url).searchParams.get(TOKEN_PARAM);
    const token = queryToken ?? cookieValue(req, TOKEN_PARAM);
    const ownerKey = deps.workspaceOf(bearer) === instance.workspace_id;
    const allowed =
      ownerKey ||
      sameKey(req.headers.get("x-agent-key"), instance.agent_key) ||
      (token !== undefined && deps.signer.verify(token, instanceId, port));
    if (!allowed) {
      return json(401, "unauthorized", "Send the API key, X-Agent-Key or a signed URL");
    }
    // Our credentials never reach the sandbox; the app may use Authorization itself.
    const drop = ["x-agent-key"];
    if (ownerKey) drop.push("authorization");
    const res = await forward(req, instanceId, port, drop);
    if (queryToken) {
      // The first request turns the token into a cookie for this host, like Agent37.
      const [, , exp] = queryToken.split(".");
      const maxAge = Math.max(0, Number(exp) - Math.floor(Date.now() / 1000));
      const withCookie = new Response(res.body, res);
      withCookie.headers.append(
        "set-cookie",
        `${TOKEN_PARAM}=${queryToken}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax`,
      );
      return withCookie;
    }
    return res;
  }

  /** Public port: no credential. Returns undefined when the label is not a public port. */
  async function publicPort(req: Request, label: string): Promise<Response | undefined> {
    const target = deps.publicPorts.resolve(label);
    if (!target) return undefined;
    return forward(req, target.instanceId, target.port, []);
  }

  return { preview, publicPort };
}
