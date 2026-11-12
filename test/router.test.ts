import { describe, expect, it } from "vitest";
import { parseHost } from "../src/router/hosts.ts";
import { PublicPorts, UrlSigner } from "../src/router/ports.ts";

describe("parseHost", () => {
  it("tells the four kinds of host apart", () => {
    expect(parseHost("localhost:3000", "sb-")).toEqual({ kind: "api" });
    expect(parseHost("sb-abc123.localhost:3000", "sb-")).toEqual({
      kind: "agent",
      id: "sb-abc123",
    });
    expect(parseHost("SB-ABC123-8080.localhost", "sb-")).toEqual({
      kind: "preview",
      id: "sb-abc123",
      port: 8080,
    });
    expect(parseHost("hooks-sb-abc123.localhost", "sb-")).toEqual({
      kind: "public",
      label: "hooks-sb-abc123",
    });
    expect(parseHost("sb-abc123-99999.localhost", "sb-")).toEqual({
      kind: "public",
      label: "sb-abc123-99999",
    });
  });
});

describe("UrlSigner", () => {
  const signer = new UrlSigner("api-key");
  const later = new Date(Date.now() + 60_000);

  it("verifies its own tokens for the right instance and port only", () => {
    const token = signer.sign("sb-a", 8080, later);
    expect(signer.verify(token, "sb-a", 8080)).toBe(true);
    expect(signer.verify(token, "sb-a", 8081)).toBe(false);
    expect(signer.verify(token, "sb-b", 8080)).toBe(false);
    expect(signer.verify(token.replace("8080", "8081"), "sb-a", 8081)).toBe(false);
    expect(new UrlSigner("other-key").verify(token, "sb-a", 8080)).toBe(false);
    expect(signer.verify("junk", "sb-a", 8080)).toBe(false);
  });

  it("rejects expired tokens", () => {
    const token = signer.sign("sb-a", 8080, new Date(Date.now() - 1000));
    expect(signer.verify(token, "sb-a", 8080)).toBe(false);
  });
});

describe("PublicPorts", () => {
  it("names hosts by prefix or slug, refuses duplicates, forgets removed ports", () => {
    const ports = new PublicPorts();
    const a = ports.add("sb-1", { port: 8080, prefix: "hooks", label: "Webhooks" });
    expect(a.host_label).toBe("hooks-sb-1");
    const b = ports.add("sb-1", { port: 9000 });
    expect(b.host_label).toMatch(/^[a-z0-9]{20}$/);
    expect(() => ports.add("sb-1", { port: 8080 })).toThrow(/already public/);
    expect(ports.resolve("hooks-sb-1")).toEqual({ instanceId: "sb-1", port: 8080 });
    expect(ports.remove("sb-1", 8080)).toBe(true);
    expect(ports.resolve("hooks-sb-1")).toBeUndefined();
    ports.removeInstance("sb-1");
    expect(ports.resolve(b.host_label)).toBeUndefined();
    expect(ports.list("sb-1")).toEqual([]);
  });
});
