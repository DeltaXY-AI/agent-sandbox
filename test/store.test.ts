import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_WORKSPACE_ID, Store } from "../src/store/store.ts";

const dirs: string[] = [];
function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "agent-sandbox-store-"));
  dirs.push(dir);
  return join(dir, "nested", "test.db");
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("Store", () => {
  it("mints keys shown once, finds them by hash, and revokes them", () => {
    const store = new Store(":memory:");
    const ws = store.createWorkspace("acme", { plan: "trial" });
    const { key, record } = store.createKey(ws.id, "ci");
    expect(key).toMatch(/^sk_live_[0-9a-f]{48}$/);
    expect(record.prefix).toBe(key.slice(0, 12));
    expect(store.findKey(key)?.workspace_id).toBe(ws.id);
    expect(store.findKey(`${key}x`)).toBeUndefined();
    expect(store.findKey("")).toBeUndefined();
    expect(store.revokeKey(ws.id, record.id)).toBe(true);
    expect(store.revokeKey(ws.id, record.id)).toBe(false);
    expect(store.findKey(key)).toBeUndefined();
    expect(store.listKeys(ws.id)[0]?.revoked_at).not.toBeNull();
  });

  it("keeps workspaces, keys, instances and secrets across a reopen; never stores plain keys", () => {
    const path = tempDb();
    const first = new Store(path);
    const ws = first.createWorkspace("acme");
    const { key } = first.createKey(ws.id);
    first.saveInstance({
      id: "sb-1",
      workspace_id: ws.id,
      template: "fx",
      agent_key: "ak_1",
      idle_timeout_seconds: 900,
      metadata: { a: "b" },
      created_at: "2026-11-12T00:00:00.000Z",
    });
    const secret = first.secret("signed_url_key");
    first.close();

    expect(readFileSync(path).includes(Buffer.from(key))).toBe(false);
    const second = new Store(path);
    expect(second.findKey(key)?.workspace_id).toBe(ws.id);
    expect(second.loadInstances()).toEqual([
      expect.objectContaining({ id: "sb-1", agent_key: "ak_1" }),
    ]);
    expect(second.secret("signed_url_key")).toBe(secret);
    second.deleteInstance("sb-1");
    expect(second.loadInstances()).toEqual([]);
    second.close();
  });

  it("bootstraps the default workspace with the env key, and a changed env key replaces it", () => {
    const store = new Store(":memory:");
    store.bootstrapDefault("old-key");
    expect(store.findKey("old-key")?.workspace_id).toBe(DEFAULT_WORKSPACE_ID);
    store.bootstrapDefault("old-key"); // idempotent
    expect(store.listKeys(DEFAULT_WORKSPACE_ID)).toHaveLength(1);
    store.bootstrapDefault("new-key");
    expect(store.findKey("old-key")).toBeUndefined();
    expect(store.findKey("new-key")?.workspace_id).toBe(DEFAULT_WORKSPACE_ID);
  });

  it("refuses an env key that already belongs to another workspace", () => {
    const store = new Store(":memory:");
    const ws = store.createWorkspace("acme");
    const { key } = store.createKey(ws.id);
    expect(() => store.bootstrapDefault(key)).toThrow(/another workspace/);
  });
});
