import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { RunStore } from "../../../packages/core/src/run-store";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const tsxBin = join(repoRoot, "node_modules", ".bin", "tsx");
const cliEntry = join(repoRoot, "apps", "cli", "src", "index.ts");
const tsconfig = join(repoRoot, "tsconfig.base.json");

describe("kakashi CLI run inspection commands", () => {
  it("lists runs and prints event logs as machine-readable JSON", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kakashi-cli-"));
    const store = new RunStore(join(cwd, ".kakashi", "runs"));
    const first = await store.create("auto", "build a dashboard", join(cwd, "out-a"));
    await store.appendEvent(first.runId, "planning", "info", "Planning finished.");

    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = await store.create("interactive", "build a CLI", join(cwd, "out-b"));

    const runs = await runCli(["runs", "--json"], cwd);
    expect(runs.exitCode).toBe(0);
    expect(runs.stderr).toBe("");
    const runPayload = JSON.parse(runs.stdout) as Array<{ runId: string; mode: string }>;
    expect(runPayload.map((run) => run.runId)).toEqual([second.runId, first.runId]);
    expect(runPayload[0]?.mode).toBe("interactive");

    const events = await runCli(["events", first.runId, "--json"], cwd);
    expect(events.exitCode).toBe(0);
    const eventPayload = JSON.parse(events.stdout) as Array<{ message: string; stage: string }>;
    expect(eventPayload.map((event) => event.message)).toContain("Planning finished.");
    expect(eventPayload.map((event) => event.stage)).toContain("planning");
  });

  it("returns a non-zero exit code when event inspection targets a missing run", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kakashi-cli-"));

    const result = await runCli(["events", "missing-run"], cwd);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Run not found: missing-run");
  });

  it("prints JSON errors for missing runs when JSON output is requested", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kakashi-cli-"));

    const result = await runCli(["events", "missing-run", "--json"], cwd);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({ error: "Run not found: missing-run" });
  });

  it("rejects invalid auto-run numeric options before external authentication", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kakashi-cli-"));

    const result = await runCli(["run", "build a cli", "--out", "out", "--max-repos", "abc"], cwd, {
      GITHUB_TOKEN: "",
      GH_TOKEN: "",
      GH_CONFIG_DIR: join(cwd, "gh-config")
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("max-repos must be a positive integer.");
    expect(result.stderr).not.toContain("GitHub authentication");
  });

  it("rejects invalid repair iteration counts before creating a run", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kakashi-cli-"));

    const result = await runCli(["run", "build a cli", "--out", "out", "--max-iterations", "0"], cwd);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("max-iterations must be a positive integer.");
    expect(result.stderr).not.toContain("Run created");
  });

  it("prints JSON errors for invalid run options when JSON output is requested", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kakashi-cli-"));

    const result = await runCli(["run", "build a cli", "--out", "out", "--max-repos", "abc", "--json"], cwd);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({ error: "max-repos must be a positive integer." });
  });

  it("rejects the current workspace as an output directory before GitHub access", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kakashi-cli-"));

    const result = await runCli(["run", "build a cli", "--out", ".", "--force"], cwd, {
      GITHUB_TOKEN: "",
      GH_TOKEN: "",
      GH_CONFIG_DIR: join(cwd, "gh-config")
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Output directory must not be the current workspace or one of its parent directories.");
    expect(result.stderr).not.toContain("GitHub authentication");
  });

  it("rejects parent directories as output targets", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kakashi-cli-"));

    const result = await runCli(["run", "build a cli", "--out", "..", "--json"], cwd);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      error: "Output directory must not be the current workspace or one of its parent directories."
    });
  });

  it("rejects invalid server ports before starting the server", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kakashi-cli-"));

    const result = await runCli(["serve", "--port", "abc", "--no-web"], cwd);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("port must be an integer between 1 and 65535.");
    expect(result.stdout).not.toContain("Kakashi server listening");
  });

  it("rejects out-of-range server ports", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kakashi-cli-"));

    const result = await runCli(["serve", "--port", "70000", "--no-web"], cwd);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("port must be an integer between 1 and 65535.");
    expect(result.stdout).not.toContain("Kakashi server listening");
  });
});

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

async function runCli(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): Promise<CliResult> {
  return await new Promise((resolveRun) => {
    const child = spawn(tsxBin, ["--tsconfig", tsconfig, cliEntry, ...args], {
      cwd,
      env: {
        ...process.env,
        ...env,
        FORCE_COLOR: "0"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("close", (exitCode) => {
      resolveRun({ stdout, stderr, exitCode });
    });
  });
}
