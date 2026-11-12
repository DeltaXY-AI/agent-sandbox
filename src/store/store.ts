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

export interface InstanceEvent {
  instance_id: string;
  workspace_id: string;
  /** The instance status entered (running, sleeping, ...), or "deleted". */
  state: string;
  at_ms: number;
}

export interface TurnUsage {
  instance_id: string;
  workspace_id: string;
  response_id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  at_ms: number;
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
      -- Meter: every instance state change, and every finished turn's tokens. Kept after
      -- the instance is deleted, so usage history stays complete.
      CREATE TABLE IF NOT EXISTS instance_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        instance_id TEXT NOT NULL, workspace_id TEXT NOT NULL, state TEXT NOT NULL,
        at_ms INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS instance_events_ws ON instance_events (workspace_id, at_ms);
      CREATE TABLE IF NOT EXISTS turn_usage (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        instance_id TEXT NOT NULL, workspace_id TEXT NOT NULL, response_id TEXT NOT NULL,
        model TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
        at_ms INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS turn_usage_ws ON turn_usage (workspace_id, at_ms);
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

  // --- meter

  addInstanceEvent(e: InstanceEvent): void {
    this.db
      .prepare(
        "INSERT INTO instance_events (instance_id, workspace_id, state, at_ms) VALUES (?, ?, ?, ?)",
      )
      .run(e.instance_id, e.workspace_id, e.state, e.at_ms);
  }

  /** A workspace's instance events before `beforeMs`, oldest first (earlier ones set the state). */
  instanceEvents(workspaceId: string, beforeMs: number, instanceId?: string): InstanceEvent[] {
    const rows = instanceId
      ? this.db
          .prepare(
            "SELECT * FROM instance_events WHERE workspace_id = ? AND instance_id = ? AND at_ms < ?" +
              " ORDER BY at_ms, seq",
          )
          .all(workspaceId, instanceId, beforeMs)
      : this.db
          .prepare(
            "SELECT * FROM instance_events WHERE workspace_id = ? AND at_ms < ? ORDER BY at_ms, seq",
          )
          .all(workspaceId, beforeMs);
    return rows.map((r) => ({
      instance_id: String(r.instance_id),
      workspace_id: String(r.workspace_id),
      state: String(r.state),
      at_ms: Number(r.at_ms),
    }));
  }

  addTurnUsage(u: TurnUsage): void {
    this.db
      .prepare(
        "INSERT INTO turn_usage" +
          " (instance_id, workspace_id, response_id, model, input_tokens, output_tokens, at_ms)" +
          " VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        u.instance_id,
        u.workspace_id,
        u.response_id,
        u.model,
        u.input_tokens,
        u.output_tokens,
        u.at_ms,
      );
  }

  turnUsage(workspaceId: string, fromMs: number, toMs: number): TurnUsage[] {
    return this.db
      .prepare(
        "SELECT * FROM turn_usage WHERE workspace_id = ? AND at_ms >= ? AND at_ms < ? ORDER BY at_ms",
      )
      .all(workspaceId, fromMs, toMs)
      .map((r) => ({
        instance_id: String(r.instance_id),
        workspace_id: String(r.workspace_id),
        response_id: String(r.response_id),
        model: String(r.model),
        input_tokens: Number(r.input_tokens),
        output_tokens: Number(r.output_tokens),
        at_ms: Number(r.at_ms),
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
