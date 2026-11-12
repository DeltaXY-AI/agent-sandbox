// All settings come from environment variables (load with `node --env-file=.env`).

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}. Add it to .env.`);
  return value;
}

export interface Config {
  port: number;
  /** Key of the built-in default workspace. */
  apiKey: string;
  /** Guards /v1/admin (workspaces and keys). Optional: without it the admin API is off. */
  adminKey: string | undefined;
  /** SQLite file for workspaces, keys and instance records. */
  databasePath: string;
  /** Prefix for sandbox names this platform owns. Other sbx sandboxes are ignored. */
  sandboxPrefix: string;
  defaultModel: string;
}

export function loadConfig(): Config {
  return {
    port: Number(process.env.PORT ?? 3000),
    apiKey: required("AGENT_SANDBOX_API_KEY"),
    adminKey: process.env.AGENT_SANDBOX_ADMIN_KEY || undefined,
    databasePath: process.env.DATABASE_PATH ?? "data/agent-sandbox.db",
    sandboxPrefix: process.env.SANDBOX_PREFIX ?? "sb-",
    defaultModel: process.env.DEFAULT_MODEL ?? "deepseek/deepseek-v4.1-flash",
  };
}
