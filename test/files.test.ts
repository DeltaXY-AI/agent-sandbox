import { describe, expect, it } from "vitest";
import { contentType, parseListing, resolvePath } from "../src/api/files.ts";

describe("files helpers", () => {
  it("resolves ~, relative and dotted paths against /home/agent", () => {
    expect(resolvePath(undefined)).toBe("/home/agent");
    expect(resolvePath("~")).toBe("/home/agent");
    expect(resolvePath("~/a.txt")).toBe("/home/agent/a.txt");
    expect(resolvePath("hello.py")).toBe("/home/agent/hello.py");
    expect(resolvePath("/tmp/../etc/hosts")).toBe("/etc/hosts");
    expect(() => resolvePath("a\0b")).toThrow();
  });

  it("parses find output: directories first, names case-insensitive, hidden flag", () => {
    const out =
      "f\t15\t1781049642.5\thello.py\0" +
      "d\t4096\t1781049600\tworkspace\0" +
      "f\t3\t1781049500\t.bashrc\0" +
      "d\t4096\t1781049600\tAbc\0" +
      "l\t9\t1781049600\tlink\0" +
      "f\t1\t1781049600\twith\ttab\0";
    const { entries, truncated } = parseListing("/home/agent", out);
    expect(truncated).toBe(false);
    expect(entries.map((e) => e.name)).toEqual([
      "Abc",
      "workspace",
      ".bashrc",
      "hello.py",
      "link",
      "with\ttab",
    ]);
    expect(entries.find((e) => e.name === "hello.py")).toEqual({
      name: "hello.py",
      path: "/home/agent/hello.py",
      type: "file",
      size: 15,
      modified: 1781049642500,
      hidden: false,
    });
    expect(entries.find((e) => e.name === "workspace")?.size).toBeNull();
    expect(entries.find((e) => e.name === ".bashrc")?.hidden).toBe(true);
    expect(entries.find((e) => e.name === "link")?.type).toBe("symlink");
  });

  it("caps listings at 1000 entries", () => {
    const out = Array.from({ length: 1001 }, (_, i) => `f\t1\t1\tf${i}\0`).join("");
    const { entries, truncated } = parseListing("/x", out);
    expect(entries).toHaveLength(1000);
    expect(truncated).toBe(true);
  });

  it("picks a content type from the extension", () => {
    expect(contentType("/a/hello.py")).toBe("text/x-python; charset=utf-8");
    expect(contentType("/a/x.PNG")).toBe("image/png");
    expect(contentType("/a/noext")).toBe("application/octet-stream");
  });
});
