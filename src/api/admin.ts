// Admin API: how another system (sign-up, billing) creates workspaces and their keys.
// Guarded by AGENT_SANDBOX_ADMIN_KEY (Authorization: Bearer). SPEC decision 30.
//   POST   /v1/admin/workspaces                    -> workspace + its first API key
//   GET    /v1/admin/workspaces
//   GET    /v1/admin/workspaces/{id}               -> workspace + key list (no secrets)
//   POST   /v1/admin/workspaces/{id}/keys          -> a new API key, shown once
//   DELETE /v1/admin/workspaces/{id}/keys/{keyId}  -> revoke
import { Hono } from "hono";
import { z } from "zod";
import { ApiError } from "../instances/service.ts";
import type { ApiKeyRecord, Store, Workspace } from "../store/store.ts";

const workspaceBody = z.object({
  name: z.string().min(1).max(100),
  metadata: z.record(z.string(), z.string()).optional(),
});
const keyBody = z.object({ name: z.string().max(100).optional() });

const showKey = (k: ApiKeyRecord) => ({
  id: k.id,
  name: k.name,
  prefix: k.prefix,
  created_at: k.created_at,
  revoked_at: k.revoked_at,
});

export function adminRoutes(store: Store) {
  const app = new Hono();

  const workspace = (id: string): Workspace => {
    const ws = store.getWorkspace(id);
    if (!ws) throw new ApiError(404, "workspace_not_found", `No workspace ${id}`);
    return ws;
  };

  app.post("/workspaces", async (c) => {
    const body = workspaceBody.parse(await c.req.json());
    const ws = store.createWorkspace(body.name, body.metadata);
    const { key, record } = store.createKey(ws.id, "initial");
    // The plain key appears in this response only; we keep its hash.
    return c.json({ workspace: ws, api_key: { ...showKey(record), key } }, 201);
  });

  app.get("/workspaces", (c) => c.json({ data: store.listWorkspaces() }));

  app.get("/workspaces/:id", (c) => {
    const ws = workspace(c.req.param("id"));
    return c.json({ ...ws, api_keys: store.listKeys(ws.id).map(showKey) });
  });

  app.post("/workspaces/:id/keys", async (c) => {
    const ws = workspace(c.req.param("id"));
    const body = keyBody.parse(await c.req.json().catch(() => ({})));
    const { key, record } = store.createKey(ws.id, body.name ?? null);
    return c.json({ ...showKey(record), key }, 201);
  });

  app.delete("/workspaces/:id/keys/:keyId", (c) => {
    const ws = workspace(c.req.param("id"));
    if (!store.revokeKey(ws.id, c.req.param("keyId"))) {
      throw new ApiError(404, "key_not_found", "No live key with that id");
    }
    return c.json({ id: c.req.param("keyId"), revoked: true });
  });

  return app;
}
