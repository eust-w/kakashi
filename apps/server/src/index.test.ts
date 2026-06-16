import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveOutputDirInsideWorkDir } from "./output-path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const tsxBin = join(repoRoot, "node_modules", ".bin", "tsx");
const serverEntry = join(repoRoot, "apps", "server", "src", "index.ts");
const tsconfig = join(repoRoot, "tsconfig.base.json");

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

describe("server run lifecycle", () => {
  it("does not mutate terminal run state when a stale cancel request arrives", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "kakashi-server-work-"));
    const runId = `run-${Date.now()}`;
    const statePath = join(workDir, ".kakashi", "runs", runId, "state.json");
    const now = new Date().toISOString();
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(
      statePath,
      JSON.stringify(
        {
          runId,
          mode: "auto",
          stage: "completed",
          requirementText: "finished project",
          outputDir: resolve(workDir, "out"),
          createdAt: now,
          updatedAt: now
        },
        null,
        2
      ),
      "utf8"
    );

    await withRunningServer(workDir, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/runs/${runId}/cancel`, { method: "POST" });
      const body = (await response.json()) as { error?: string };

      expect(response.status).toBe(409);
      expect(body.error).toMatch(/terminal/i);
    });

    const saved = JSON.parse(await readFile(statePath, "utf8")) as { stage: string };
    expect(saved.stage).toBe("completed");
  });
});

async function withRunningServer(workDir: string, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const port = await getOpenPort();
  const child = spawn(tsxBin, ["--tsconfig", tsconfig, serverEntry, `--port=${port}`], {
    cwd: workDir,
    env: { ...process.env, KAKASHI_WEB_DIST: "" }
  });
  const output = captureOutput(child);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(baseUrl, child, output);
    await run(baseUrl);
  } finally {
    child.kill("SIGTERM");
    if (child.exitCode === null) await once(child, "exit");
  }
}

async function getOpenPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  server.close();
  await once(server, "close");
  return port;
}

function captureOutput(child: ChildProcessWithoutNullStreams): { stdout: string; stderr: string } {
  const output = { stdout: "", stderr: "" };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output.stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    output.stderr += chunk;
  });
  return output;
}

async function waitForHealth(
  baseUrl: string,
  child: ChildProcessWithoutNullStreams,
  output: { stdout: string; stderr: string }
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        [
          `Server exited before becoming ready with code ${child.exitCode}.`,
          `stdout:\n${tail(output.stdout) || "<empty>"}`,
          `stderr:\n${tail(output.stderr) || "<empty>"}`
        ].join("\n")
      );
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  }
  throw new Error(
    [`Server did not become ready within 5 seconds.`, `stdout:\n${tail(output.stdout) || "<empty>"}`, `stderr:\n${tail(output.stderr) || "<empty>"}`].join(
      "\n"
    )
  );
}

function tail(value: string): string {
  return value.trim().slice(-4_000);
}
