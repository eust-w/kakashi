import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { Doctor } from "./doctor";

const originalPath = process.env.PATH;
const originalGitHubToken = process.env.GITHUB_TOKEN;
const originalGhToken = process.env.GH_TOKEN;

describe("Doctor", () => {
  afterEach(() => {
    process.env.PATH = originalPath;
    restoreEnv("GITHUB_TOKEN", originalGitHubToken);
    restoreEnv("GH_TOKEN", originalGhToken);
  });

  it("reports Codex authentication when codex login status succeeds", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kakashi-doctor-"));
    const binDir = join(cwd, "bin");
    await mkdir(binDir, { recursive: true });
    await writeCodex(binDir, [
      'if [ "$1" = "--version" ]; then echo "codex-cli 1.0.0"; exit 0; fi',
      'if [ "$1" = "login" ] && [ "$2" = "status" ]; then echo "Logged in using ChatGPT"; exit 0; fi',
      "exit 2"
    ]);
    process.env.PATH = [binDir, originalPath].filter(Boolean).join(":");
    process.env.GITHUB_TOKEN = "github-token-for-doctor-test";
    process.env.GH_TOKEN = "";

    const checks = await new Doctor().run(cwd);

    expect(checks.find((check) => check.name === "codex")?.ok).toBe(true);
    expect(checks.find((check) => check.name === "codex-version")?.detail).toContain("codex-cli 1.0.0");
    expect(checks.find((check) => check.name === "codex-auth")).toMatchObject({
      ok: true,
      detail: "Logged in using ChatGPT"
    });
  });

  it("reports a failed Codex authentication check when codex login status fails", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kakashi-doctor-"));
    const binDir = join(cwd, "bin");
    await mkdir(binDir, { recursive: true });
    await writeCodex(binDir, [
      'if [ "$1" = "--version" ]; then echo "codex-cli 1.0.0"; exit 0; fi',
      'if [ "$1" = "login" ] && [ "$2" = "status" ]; then echo "not logged in" >&2; exit 1; fi',
      "exit 2"
    ]);
    process.env.PATH = [binDir, originalPath].filter(Boolean).join(":");
    process.env.GITHUB_TOKEN = "github-token-for-doctor-test";
    process.env.GH_TOKEN = "";

    const checks = await new Doctor().run(cwd);

    expect(checks.find((check) => check.name === "codex-auth")).toMatchObject({
      ok: false,
      detail: "not logged in"
    });
  });

  it("reports Codex authentication as unavailable when the codex command is missing", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kakashi-doctor-"));
    process.env.PATH = "";
    process.env.GITHUB_TOKEN = "github-token-for-doctor-test";
    process.env.GH_TOKEN = "";

    const checks = await new Doctor().run(cwd);

    expect(checks.find((check) => check.name === "codex")).toMatchObject({
      ok: false,
      detail: "codex was not found on PATH."
    });
    expect(checks.find((check) => check.name === "codex-auth")).toMatchObject({
      ok: false,
      detail: "codex was not found on PATH."
    });
    expect(checks.some((check) => check.name === "codex-version")).toBe(false);
  });
});

async function writeCodex(binDir: string, body: string[]): Promise<void> {
  const path = join(binDir, "codex");
  await writeFile(path, `#!/bin/sh\n${body.join("\n")}\n`, "utf8");
  await chmod(path, 0o755);
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
