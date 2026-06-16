import { mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { resolveOutputDirInsideWorkDir } from "./output-path";

describe("resolveOutputDirInsideWorkDir", () => {
  it("keeps relative output directories inside the work directory", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "kakashi-server-work-"));

    expect(resolveOutputDirInsideWorkDir(workDir, "generated/app")).toBe(resolve(workDir, "generated/app"));
  });

  it("rejects absolute or parent-traversing output directories outside the work directory", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "kakashi-server-work-"));

    expect(() => resolveOutputDirInsideWorkDir(workDir, "/tmp/kakashi-outside")).toThrow(/inside the server work directory/);
    expect(() => resolveOutputDirInsideWorkDir(workDir, "../outside")).toThrow(/inside the server work directory/);
  });

  it("rejects the work directory itself as an output directory", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "kakashi-server-work-"));

    expect(() => resolveOutputDirInsideWorkDir(workDir, ".")).toThrow(/must not be the server work directory/);
  });
});
