// An eve sandbox provider that runs commands on this machine. The agent-sandbox platform
// already gives every agent its own microVM, so eve's tools run right here in /home/agent
// instead of in a second sandbox (eve's built-in providers need Docker or Vercel).
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  defineSandboxProvider,
  SANDBOX_AGENT_ENV,
  type SandboxConnection,
} from "eve/sandbox/provider";

const WORKSPACE = "/home/agent";

function connect(): SandboxConnection {
  return {
    workspaceRoot: WORKSPACE,
    async spawn({ command, env, workingDirectory, signal, stdin }) {
      const child = spawn("bash", ["-lc", command], {
        cwd: workingDirectory,
        env: { ...process.env, ...SANDBOX_AGENT_ENV, ...env },
        stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"],
        // Own process group, so aborting kills the whole tree.
        detached: true,
      });
      const exited = new Promise<{ exitCode: number }>((resolve) => {
        child.on("close", (code, sig) => resolve({ exitCode: code ?? (sig ? 137 : 1) }));
        child.on("error", () => resolve({ exitCode: 127 }));
      });
      const killTree = () => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          // already gone
        }
      };
      signal?.addEventListener("abort", killTree, { once: true });
      return {
        pid: child.pid,
        stdin:
          stdin && child.stdin
            ? (Writable.toWeb(child.stdin) as WritableStream<Uint8Array>)
            : undefined,
        stdout: Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
        stderr: Readable.toWeb(child.stderr!) as ReadableStream<Uint8Array>,
        wait: () => exited,
        kill: async () => {
          killTree();
          await exited;
        },
      };
    },
    async readFile({ path }) {
      try {
        return new Uint8Array(await readFile(path));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },
    async writeFiles({ files }) {
      for (const f of files) {
        await mkdir(dirname(f.path), { recursive: true });
        await writeFile(f.path, f.content);
      }
    },
    async removePath({ path, force, recursive }) {
      await rm(path, { force: Boolean(force), recursive: Boolean(recursive) });
    },
    // The machine itself is the sandbox; there is nothing to suspend.
    async stop() {},
  };
}

export const LocalSandbox = defineSandboxProvider({
  name: "local",
  environment() {
    return {
      async prepare(ctx) {
        if (!ctx.isEmpty) await ctx.populate(connect());
        return {};
      },
      async start() {
        return { connection: connect(), state: { version: 1 } };
      },
      async resume() {
        return connect();
      },
      // The sandbox VM outlives eve sessions; the platform deletes it.
      async onSessionEnd() {},
    };
  },
});
