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
});

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

async function runCli(args: string[], cwd: string): Promise<CliResult> {
  return await new Promise((resolveRun) => {
    const child = spawn(tsxBin, ["--tsconfig", tsconfig, cliEntry, ...args], {
      cwd,
      env: {
        ...process.env,
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
