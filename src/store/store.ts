// Durable state in SQLite (Node's built-in node:sqlite, no dependency): workspaces,
// API keys (hashes only), instance records and server settings. Sessions and replay
// buffers stay in memory. SPEC decision 30.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface Workspace {
  id: string;
  name: string;
  metadata: Record<string, string>;
  created_at: string;
}

export interface ApiKeyRecord {
  id: string;
  workspace_id: string;
  name: string | null;
  /** First characters of the key, to recognise it in lists. */
  prefix: string;
  /** "env": the server's AGENT_SANDBOX_API_KEY for the default workspace; "api": minted. */
  source: "env" | "api";
  created_at: string;
  revoked_at: string | null;
}

export interface InstanceRecord {
  id: string;
  workspace_id: string;
  template: string;
  agent_key: string;
  idle_timeout_seconds: number;
  metadata: Record<string, string>;
  created_at: string;
}

export const DEFAULT_WORKSPACE_ID = "ws_default";

const now = () => new Date().toISOString();
const hash = (key: string) => createHash("sha256").update(key).digest("hex");
const newId = (prefix: string) => `${prefix}_${randomBytes(8).toString("hex")}`;

export class Store {
  private readonly db: DatabaseSync;

  /** `path` is a file, or ":memory:" for tests. */
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, metadata TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        key_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL, name TEXT, source TEXT NOT NULL,
        created_at TEXT NOT NULL, revoked_at TEXT);
      CREATE TABLE IF NOT EXISTS instances (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        template TEXT NOT NULL, agent_key TEXT NOT NULL, idle_timeout_seconds INTEGER NOT NULL,
        metadata TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  close(): void {
    this.db.close();
  }

  // --- workspaces

  createWorkspace(name: string, metadata: Record<string, string> = {}, id = newId("ws")) {
    const ws: Workspace = { id, name, metadata, created_at: now() };
    this.db
      .prepare("INSERT INTO workspaces (id, name, metadata, created_at) VALUES (?, ?, ?, ?)")
      .run(ws.id, ws.name, JSON.stringify(ws.metadata), ws.created_at);
    return ws;
  }

  getWorkspace(id: string): Workspace | undefined {
    const row = this.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id);
    return row ? toWorkspace(row) : undefined;
  }

  listWorkspaces(): Workspace[] {
    return this.db.prepare("SELECT * FROM workspaces ORDER BY created_at").all().map(toWorkspace);
  }

  // --- API keys

  /** Mint a key. The plain key is returned once and only its hash is stored. */
  createKey(workspaceId: string, name: string | null = null) {
    const key = `sk_live_${randomBytes(24).toString("hex")}`;
    return { key, record: this.insertKey(workspaceId, key, name, "api") };
  }

  private insertKey(workspaceId: string, key: string, name: string | null, source: "env" | "api") {
    const record: ApiKeyRecord = {
      id: newId("key"),
      workspace_id: workspaceId,
      name,
      prefix: key.slice(0, 12),
      source,
      created_at: now(),
      revoked_at: null,
    };
    this.db
      .prepare(
        "INSERT INTO api_keys (id, workspace_id, key_hash, prefix, name, source, created_at)" +
          " VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(record.id, workspaceId, hash(key), record.prefix, name, source, record.created_at);
    return record;
  }

  /** The live key record for a presented key, or undefined. */
  findKey(key: string): ApiKeyRecord | undefined {
    if (!key) return undefined;
    const row = this.db
      .prepare("SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL")
      .get(hash(key));
    return row ? toKey(row) : undefined;
  }

  listKeys(workspaceId: string): ApiKeyRecord[] {
    return this.db
      .prepare("SELECT * FROM api_keys WHERE workspace_id = ? ORDER BY created_at")
      .all(workspaceId)
      .map(toKey);
  }

  revokeKey(workspaceId: string, keyId: string): boolean {
    const result = this.db
      .prepare(
        "UPDATE api_keys SET revoked_at = ? WHERE id = ? AND workspace_id = ? AND revoked_at IS NULL",
      )
      .run(now(), keyId, workspaceId);
    return Number(result.changes) > 0;
  }

  /**
   * The default workspace and its env-managed key (AGENT_SANDBOX_API_KEY). A changed
   * env key replaces the old one, so the previous value stops working.
   */
  bootstrapDefault(envKey: string): Workspace {
    const ws =
      this.getWorkspace(DEFAULT_WORKSPACE_ID) ??
      this.createWorkspace("default", {}, DEFAULT_WORKSPACE_ID);
    const current = this.findKey(envKey);
    if (current && current.workspace_id !== ws.id) {
      throw new Error("AGENT_SANDBOX_API_KEY is already a key of another workspace");
    }
    this.db
      .prepare(
        "UPDATE api_keys SET revoked_at = ? WHERE workspace_id = ? AND source = 'env'" +
          " AND key_hash != ? AND revoked_at IS NULL",
      )
      .run(now(), ws.id, hash(envKey));
    if (!current) this.insertKey(ws.id, envKey, "AGENT_SANDBOX_API_KEY", "env");
    return ws;
  }

  // --- instances

  saveInstance(r: InstanceRecord): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO instances" +
          " (id, workspace_id, template, agent_key, idle_timeout_seconds, metadata, created_at)" +
          " VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        r.id,
        r.workspace_id,
        r.template,
        r.agent_key,
        r.idle_timeout_seconds,
        JSON.stringify(r.metadata),
        r.created_at,
      );
  }

  deleteInstance(id: string): void {
    this.db.prepare("DELETE FROM instances WHERE id = ?").run(id);
  }

  loadInstances(): InstanceRecord[] {
    return this.db
      .prepare("SELECT * FROM instances")
      .all()
      .map((row) => ({
        id: String(row.id),
        workspace_id: String(row.workspace_id),
        template: String(row.template),
        agent_key: String(row.agent_key),
        idle_timeout_seconds: Number(row.idle_timeout_seconds),
        metadata: JSON.parse(String(row.metadata)) as Record<string, string>,
        created_at: String(row.created_at),
      }));
  }

  // --- settings

  /** A random secret generated on first use and kept, e.g. the signed-URL key. */
  secret(name: string): string {
    const row = this.db.prepare("SELECT value FROM settings WHERE name = ?").get(name);
    if (row) return String(row.value);
    const value = randomBytes(32).toString("hex");
    this.db.prepare("INSERT INTO settings (name, value) VALUES (?, ?)").run(name, value);
    return value;
  }
}

function toWorkspace(row: Record<string, unknown>): Workspace {
  return {
    id: String(row.id),
    name: String(row.name),
    metadata: JSON.parse(String(row.metadata)) as Record<string, string>,
    created_at: String(row.created_at),
  };
}

function toKey(row: Record<string, unknown>): ApiKeyRecord {
  return {
    id: String(row.id),
    workspace_id: String(row.workspace_id),
    name: row.name === null ? null : String(row.name),
    prefix: String(row.prefix),
    source: row.source === "env" ? "env" : "api",
    created_at: String(row.created_at),
    revoked_at: row.revoked_at === null ? null : String(row.revoked_at),
  };
}
