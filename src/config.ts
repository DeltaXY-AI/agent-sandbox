// All settings come from environment variables (load with `node --env-file=.env`).

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}. Add it to .env.`);
  return value;
}

export interface Config {
  port: number;
  apiKey: string;
  /** Prefix for sandbox names this platform owns. Other sbx sandboxes are ignored. */
  sandboxPrefix: string;
  defaultModel: string;
}

export function loadConfig(): Config {
  return {
    port: Number(process.env.PORT ?? 3000),
    apiKey: required("AGENT_SANDBOX_API_KEY"),
    sandboxPrefix: process.env.SANDBOX_PREFIX ?? "sb-",
    defaultModel: process.env.DEFAULT_MODEL ?? "deepseek/deepseek-v4.1-flash",
  };
}
