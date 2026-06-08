import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { emptyDir, ensureDir, findFirstExisting, isDirectoryEmpty, pathExists, readJsonFile, writeJsonFile } from "./fs";

describe("filesystem helpers", () => {
  it("reads, writes, empties, and discovers real files", async () => {
    const root = await mkdtemp(join(tmpdir(), "kakashi-fs-"));
    const nested = join(root, "a", "b");
    const jsonPath = join(nested, "data.json");

    expect(await pathExists(join(root, "missing"))).toBe(false);
    expect(await isDirectoryEmpty(join(root, "missing-dir"))).toBe(true);

    await writeJsonFile(jsonPath, { ok: true, count: 2 });
    expect(await pathExists(jsonPath)).toBe(true);
    await expect(readJsonFile(jsonPath)).resolves.toEqual({ ok: true, count: 2 });
    await expect(isDirectoryEmpty(nested)).resolves.toBe(false);
    await expect(findFirstExisting(root, ["none.txt", join("a", "b", "data.json")])).resolves.toBe(jsonPath);
    await expect(findFirstExisting(root, ["none.txt", "also-none.txt"])).resolves.toBeNull();

    await emptyDir(nested);
    await expect(isDirectoryEmpty(nested)).resolves.toBe(true);

    await ensureDir(join(root, "created"));
    await writeFile(join(root, "created", "file.txt"), "content", "utf8");
    await expect(isDirectoryEmpty(join(root, "created"))).resolves.toBe(false);
  });
});
