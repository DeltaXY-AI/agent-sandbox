import { describe, expect, it, vi } from "vitest";

const holds: { name: string; killed: boolean }[] = [];
/** sbx calls the fork makes, in order. */
const calls: string[] = [];
let sourceStatus = "running";
let failCreate = false;

vi.mock("../src/lib/sbx.ts", () => ({
  execInSandbox: vi.fn(async () => ({
    exitCode: 0,
    stdout: "hello\n",
    stderr: "  ✓ sandbox sb-abc — started\nreal warning\n",
    durationMs: 5,
  })),
  holdOpen: vi.fn((name: string) => {
    const hold = { name, killed: false };
    holds.push(hold);
    return { on: () => undefined, kill: () => (hold.killed = true) };
  }),
  stopSandbox: vi.fn(async (name: string) => void calls.push(`stop ${name}`)),
  startSandbox: vi.fn(async (name: string) => void calls.push(`start ${name}`)),
  listSandboxes: vi.fn(async () => [
    { name: "sb-src", id: "1", status: sourceStatus, created_at: "" },
  ]),
  saveTemplate: vi.fn(async (name: string, tag: string) => void calls.push(`save ${name} ${tag}`)),
  removeTemplate: vi.fn(async (tag: string) => void calls.push(`rm-template ${tag}`)),
  createSandbox: vi.fn(async (o: { name: string; template?: string }) => {
    calls.push(`create ${o.name} from ${o.template}`);
    if (failCreate) throw new Error("create failed");
    return { name: o.name, id: "2", status: "running", created_at: "" };
  }),
  setCustomSecret: vi.fn(async () => undefined),
  denyNetwork: vi.fn(async (name: string) => void calls.push(`deny ${name}`)),
  removeSandbox: vi.fn(async (name: string) => void calls.push(`rm ${name}`)),
}));

const { LocalWindowsHost } = await import("../src/hosts/local-windows.ts");

describe("LocalWindowsHost.exec", () => {
  it("drops the sbx auto-start line but keeps the command's own stderr", async () => {
    const result = await new LocalWindowsHost().exec("sb-abc", { cmd: ["true"] });
    expect(result.stderr).toBe("real warning\n");
    expect(result.stdout).toBe("hello\n");
  });
});

describe("LocalWindowsHost keep-awake", () => {
  it("holds one exec open while awake and lets go on sleep, then holds again on wake", async () => {
    holds.length = 0;
    const host = new LocalWindowsHost();
    await host.exec("sb-x", { cmd: ["true"] });
    await host.exec("sb-x", { cmd: ["true"] });
    expect(holds).toEqual([{ name: "sb-x", killed: false }]);
    await host.sleep("sb-x");
    expect(holds[0]?.killed).toBe(true);
    await host.wake("sb-x");
    expect(holds).toHaveLength(2);
    expect(holds[1]?.killed).toBe(false);
  });
});

describe("LocalWindowsHost.fork", () => {
  it("stops the source, saves it, wakes it while the fork is created from the image, removes the image", async () => {
    calls.length = 0;
    sourceStatus = "running";
    failCreate = false;
    await new LocalWindowsHost().fork("sb-src", { name: "sb-new", template: "fx" });
    expect(calls).toEqual([
      "stop sb-src",
      "save sb-src agent-sandbox-fork:sb-new",
      // The source wakes as soon as the image is saved, while the fork is created.
      "start sb-src",
      "create sb-new from agent-sandbox-fork:sb-new",
      "deny sb-new",
      "rm-template agent-sandbox-fork:sb-new",
    ]);
  });

  it("leaves a stopped source stopped, and cleans up when the create fails", async () => {
    calls.length = 0;
    sourceStatus = "stopped";
    failCreate = true;
    await expect(
      new LocalWindowsHost().fork("sb-src", { name: "sb-new", template: "fx" }),
    ).rejects.toThrow("create failed");
    expect(calls).toEqual([
      "save sb-src agent-sandbox-fork:sb-new",
      "create sb-new from agent-sandbox-fork:sb-new",
      "rm-template agent-sandbox-fork:sb-new",
    ]);
  });
});
