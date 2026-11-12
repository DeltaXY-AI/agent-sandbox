// Public ports (unauthenticated URLs, for webhooks) and signed preview URLs.
// Shapes and limits follow Agent37's public-ports and signed-url docs.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ApiError } from "../instances/service.ts";

export const MAX_PUBLIC_PORTS = 50;
export const SIGNED_URL_DEFAULT_TTL = 3600;
export const SIGNED_URL_MIN_TTL = 60;
export const SIGNED_URL_MAX_TTL = 604_800;
/** Query parameter that carries a signed-URL token; the router turns it into a cookie. */
export const TOKEN_PARAM = "as_token";

export interface PublicPort {
  port: number;
  prefix: string | null;
  label: string | null;
  /** First DNS label of the URL: `{prefix}-{instanceId}` or a random slug. */
  host_label: string;
  created_at: string;
}

const SLUG_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
function slug(length = 20): string {
  const bytes = randomBytes(length);
  return Array.from(bytes, (b) => SLUG_CHARS[b % SLUG_CHARS.length]).join("");
}

/** Public ports of every instance, in memory like the rest of the state. */
export class PublicPorts {
  private readonly byInstance = new Map<string, PublicPort[]>();
  private readonly byLabel = new Map<string, { instanceId: string; port: number }>();

  list(instanceId: string): PublicPort[] {
    return [...(this.byInstance.get(instanceId) ?? [])];
  }

  add(
    instanceId: string,
    input: { port: number; prefix?: string; label?: string },
    now = new Date(),
  ): PublicPort {
    const ports = this.byInstance.get(instanceId) ?? [];
    if (ports.some((p) => p.port === input.port)) {
      throw new ApiError(409, "public_port_exists", `Port ${input.port} is already public`);
    }
    if (ports.length >= MAX_PUBLIC_PORTS) {
      throw new ApiError(400, "validation_error", `At most ${MAX_PUBLIC_PORTS} public ports`);
    }
    let hostLabel = input.prefix ? `${input.prefix}-${instanceId}` : slug();
    if (this.byLabel.has(hostLabel)) {
      if (input.prefix) {
        throw new ApiError(409, "public_port_exists", `Prefix ${input.prefix} is already used`);
      }
      hostLabel = slug();
    }
    const entry: PublicPort = {
      port: input.port,
      prefix: input.prefix ?? null,
      label: input.label ?? null,
      host_label: hostLabel,
      created_at: now.toISOString(),
    };
    this.byInstance.set(instanceId, [...ports, entry]);
    this.byLabel.set(hostLabel, { instanceId, port: input.port });
    return entry;
  }

  remove(instanceId: string, port: number): boolean {
    const ports = this.byInstance.get(instanceId) ?? [];
    const entry = ports.find((p) => p.port === port);
    if (!entry) return false;
    this.byInstance.set(
      instanceId,
      ports.filter((p) => p !== entry),
    );
    this.byLabel.delete(entry.host_label);
    return true;
  }

  removeInstance(instanceId: string): void {
    for (const p of this.byInstance.get(instanceId) ?? []) this.byLabel.delete(p.host_label);
    this.byInstance.delete(instanceId);
  }

  resolve(hostLabel: string): { instanceId: string; port: number } | undefined {
    return this.byLabel.get(hostLabel);
  }
}

/**
 * Signed preview URLs: `<instanceId>.<port>.<expiresEpochSeconds>.<hmac>`. Nothing is
 * stored per link; the HMAC key is a server secret kept in the store.
 */
export class UrlSigner {
  private readonly key: Buffer;

  constructor(secret: string) {
    this.key = createHmac("sha256", "agent-sandbox signed urls").update(secret).digest();
  }

  private mac(payload: string): string {
    return createHmac("sha256", this.key).update(payload).digest("base64url");
  }

  sign(instanceId: string, port: number, expiresAt: Date): string {
    const payload = `${instanceId}.${port}.${Math.floor(expiresAt.getTime() / 1000)}`;
    return `${payload}.${this.mac(payload)}`;
  }

  /** True when `token` grants `port` on `instanceId` and has not expired. */
  verify(token: string, instanceId: string, port: number, now = Date.now()): boolean {
    const parts = token.split(".");
    if (parts.length !== 4) return false;
    const [id, p, exp, mac = ""] = parts;
    const payload = `${id}.${p}.${exp}`;
    const expected = Buffer.from(this.mac(payload));
    const given = Buffer.from(mac);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
    return id === instanceId && Number(p) === port && Number(exp) * 1000 > now;
  }
}
