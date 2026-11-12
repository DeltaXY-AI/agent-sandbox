// Files API on the agent host (SPEC section 3; shapes follow Agent37's files docs).
//   GET /v1/files?path=          one directory level, directories first
//   GET /v1/files/content?path=  raw bytes
// Runs through exec as the sandbox's agent user, so the VM's own permissions apply.
// Relative paths and `~` resolve against /home/agent.
import { posix } from "node:path";
import { Hono } from "hono";
import { ApiError, type InstanceService } from "../instances/service.ts";

type Env = { Bindings: { instanceId: string } };

export const HOME = "/home/agent";
const MAX_ENTRIES = 1000;

export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number | null;
  /** Epoch milliseconds. */
  modified: number;
  hidden: boolean;
}

/** `~/x`, `x` and `/a/../b` -> a normalized absolute path. */
export function resolvePath(input: string | undefined): string {
  const raw = (input ?? "").trim();
  if (!raw || raw === "~") return HOME;
  if (raw.includes("\0")) throw new ApiError(400, "validation_error", "path contains a NUL byte");
  const expanded = raw.startsWith("~/") ? `${HOME}/${raw.slice(2)}` : raw;
  return posix.normalize(posix.isAbsolute(expanded) ? expanded : posix.join(HOME, expanded));
}

const TYPES: Record<string, FileEntry["type"]> = { f: "file", d: "directory", l: "symlink" };

/** Parse `find -printf '%y\t%s\t%T@\t%f\0'` output into sorted entries. */
export function parseListing(
  dir: string,
  out: string,
): { entries: FileEntry[]; truncated: boolean } {
  const entries: FileEntry[] = [];
  for (const record of out.split("\0")) {
    if (!record) continue;
    const [kind = "", size = "", mtime = "", ...nameParts] = record.split("\t");
    const name = nameParts.join("\t");
    const type = TYPES[kind] ?? "other";
    entries.push({
      name,
      path: posix.join(dir, name),
      type,
      size: type === "directory" ? null : Number(size),
      modified: Math.round(Number(mtime) * 1000),
      hidden: name.startsWith("."),
    });
  }
  entries.sort((a, b) => {
    const dirFirst = Number(b.type === "directory") - Number(a.type === "directory");
    return dirFirst || a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
  return { entries: entries.slice(0, MAX_ENTRIES), truncated: entries.length > MAX_ENTRIES };
}

const CONTENT_TYPES: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".py": "text/x-python",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".ts": "text/plain",
  ".json": "application/json",
  ".html": "text/html",
  ".css": "text/css",
  ".csv": "text/csv",
  ".sh": "text/x-shellscript",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
};

export function contentType(path: string): string {
  const type = CONTENT_TYPES[posix.extname(path).toLowerCase()] ?? "application/octet-stream";
  return type.startsWith("text/") || type === "application/json" ? `${type}; charset=utf-8` : type;
}

// Exit codes the scripts use to report path problems.
const NOT_FOUND = 3;
const WRONG_TYPE = 4;

const LIST_SCRIPT =
  `[ -e "$1" ] || exit ${NOT_FOUND}; [ -d "$1" ] || exit ${WRONG_TYPE}; ` +
  `find "$1" -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%T@\\t%f\\0'`;
const READ_SCRIPT = `[ -e "$1" ] || exit ${NOT_FOUND}; [ -f "$1" ] || exit ${WRONG_TYPE}; base64 -w0 "$1"`;

export function filesRoutes(instances: InstanceService) {
  const app = new Hono<Env>();

  const run = async (instanceId: string, script: string, path: string) => {
    const result = await instances.exec(instanceId, { cmd: ["sh", "-c", script, "sh", path] });
    if (result.exitCode === NOT_FOUND)
      throw new ApiError(404, "file_not_found", `No file at ${path}`);
    return result;
  };

  app.get("/", async (c) => {
    const path = resolvePath(c.req.query("path"));
    const result = await run(c.env.instanceId, LIST_SCRIPT, path);
    if (result.exitCode === WRONG_TYPE) {
      throw new ApiError(400, "not_a_directory", `${path} is not a directory`);
    }
    if (result.exitCode !== 0) {
      throw new ApiError(400, "validation_error", result.stderr.trim() || `Cannot list ${path}`);
    }
    const { entries, truncated } = parseListing(path, result.stdout);
    return c.json({
      path,
      parentPath: path === "/" ? null : posix.dirname(path),
      entries,
      truncated,
    });
  });

  app.get("/content", async (c) => {
    if (!c.req.query("path")?.trim()) {
      throw new ApiError(400, "validation_error", "path is required");
    }
    const path = resolvePath(c.req.query("path"));
    const result = await run(c.env.instanceId, READ_SCRIPT, path);
    if (result.exitCode === WRONG_TYPE) {
      throw new ApiError(400, "validation_error", `${path} is not a regular file`);
    }
    if (result.exitCode !== 0) {
      throw new ApiError(400, "validation_error", result.stderr.trim() || `Cannot read ${path}`);
    }
    const bytes = Buffer.from(result.stdout.trim(), "base64");
    const disposition = c.req.query("disposition") === "inline" ? "inline" : "attachment";
    return new Response(bytes, {
      status: 200,
      headers: {
        "content-type": contentType(path),
        "content-length": String(bytes.length),
        "content-disposition": `${disposition}; filename="${posix.basename(path).replace(/"/g, "")}"`,
      },
    });
  });

  return app;
}
