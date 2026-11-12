import { describe, expect, it, vi } from "vitest";

const holds: { name: string; killed: boolean }[] = [];

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
  stopSandbox: vi.fn(async () => undefined),
  startSandbox: vi.fn(async () => undefined),
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
