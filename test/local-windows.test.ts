import { describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/sbx.ts", () => ({
  execInSandbox: vi.fn(async () => ({
    exitCode: 0,
    stdout: "hello\n",
    stderr: "  ✓ sandbox sb-abc — started\nreal warning\n",
    durationMs: 5,
  })),
}));

const { LocalWindowsHost } = await import("../src/hosts/local-windows.ts");

describe("LocalWindowsHost.exec", () => {
  it("drops the sbx auto-start line but keeps the command's own stderr", async () => {
    const result = await new LocalWindowsHost().exec("sb-abc", { cmd: ["true"] });
    expect(result.stderr).toBe("real warning\n");
    expect(result.stdout).toBe("hello\n");
  });
});
