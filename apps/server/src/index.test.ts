import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { applyInteractiveSelection } from "../../../packages/core/src/interactive-selection";
import type { KakashiRunState, RepoAnalysis, RepoCandidate, RequirementSpec } from "../../../packages/core/src/types";
import { resolveOutputDirInsideWorkDir } from "./output-path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
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
  it("rebuilds the interactive graph and plan from selected analyzed repositories", () => {
    const now = new Date().toISOString();
    const requirement = requirementSpec();
    const primaryAnalysis = repoAnalysis("open-source/primary", 1, "search", 0.92);
    const auxiliaryAnalysis = repoAnalysis("open-source/auxiliary", 2, "search", 0.84);
    const state: KakashiRunState = {
      runId: "run-selection",
      mode: "interactive",
      stage: "waiting_for_confirmation",
      requirementText: requirement.raw,
      outputDir: "/tmp/kakashi-selection-out",
      createdAt: now,
      updatedAt: now,
      spec: requirement,
      candidates: [primaryAnalysis.candidate, auxiliaryAnalysis.candidate],
      analyses: [primaryAnalysis, auxiliaryAnalysis]
    };

    const updated = applyInteractiveSelection(state, [auxiliaryAnalysis.candidate.fullName]);

    expect(updated.graph?.repos.map((analysis) => analysis.candidate.fullName)).toEqual([auxiliaryAnalysis.candidate.fullName]);
    expect(updated.graph?.edges.map((edge) => edge.repoFullName)).toEqual([auxiliaryAnalysis.candidate.fullName]);
    expect(updated.plan?.main.repo.fullName).toBe(auxiliaryAnalysis.candidate.fullName);
    expect(updated.plan?.auxiliaries).toHaveLength(0);
    expect(updated.plan?.requirement).toBe(requirement);
    expect(updated.plan?.outputDir).toBe(state.outputDir);
    expect(updated.stage).toBe("waiting_for_confirmation");
  });

  it("rejects an interactive selection that does not include analyzed repositories", () => {
    const now = new Date().toISOString();
    const requirement = requirementSpec();
    const state: KakashiRunState = {
      runId: "run-selection-empty",
      mode: "interactive",
      stage: "waiting_for_confirmation",
      requirementText: requirement.raw,
      outputDir: "/tmp/kakashi-selection-out",
      createdAt: now,
      updatedAt: now,
      spec: requirement,
      candidates: [],
      analyses: [repoAnalysis("open-source/primary", 1, "search", 0.92)]
    };

    expect(() => applyInteractiveSelection(state, ["missing/repo"])).toThrow(/selected repository/i);
  });

  it("persists an updated fusion plan for a stored interactive repository selection", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "kakashi-server-work-"));
    const now = new Date().toISOString();
    const requirement = requirementSpec();
    const primaryAnalysis = repoAnalysis("open-source/primary", 1, "search", 0.92);
    const auxiliaryAnalysis = repoAnalysis("open-source/auxiliary", 2, "search", 0.84);
    const state: KakashiRunState = {
      runId: "run-selection-api",
      mode: "interactive",
      stage: "waiting_for_confirmation",
      requirementText: requirement.raw,
      outputDir: resolve(workDir, "selection-out"),
      createdAt: now,
      updatedAt: now,
      spec: requirement,
      candidates: [primaryAnalysis.candidate, auxiliaryAnalysis.candidate],
      analyses: [primaryAnalysis, auxiliaryAnalysis]
    };
    const statePath = join(workDir, ".kakashi", "runs", state.runId, "state.json");
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");

    await withRunningServer(workDir, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/runs/${state.runId}/select-repositories`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selectedRepositories: [auxiliaryAnalysis.candidate.fullName] })
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as KakashiRunState;
      expect(body.plan?.main.repo.fullName).toBe(auxiliaryAnalysis.candidate.fullName);
    });

    const saved = JSON.parse(await readFile(statePath, "utf8")) as KakashiRunState;
    expect(saved.plan?.main.repo.fullName).toBe(auxiliaryAnalysis.candidate.fullName);
    expect(saved.graph?.repos.map((analysis) => analysis.candidate.fullName)).toEqual([auxiliaryAnalysis.candidate.fullName]);
  });

  it("returns 404 instead of opening an empty event stream for a missing run", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "kakashi-server-work-"));

    await withRunningServer(workDir, async (baseUrl) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1_000);
      const response = await fetch(`${baseUrl}/api/runs/missing-run/events`, { signal: controller.signal }).finally(() => {
        clearTimeout(timeout);
      });
      if (response.status !== 404) await response.body?.cancel();

      expect(response.status).toBe(404);
      const body = (await response.json()) as { error?: string };
      expect(body.error).toBe("Run not found");
    });
  });

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

  it("removes failed interactive preparation from the active run registry", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "kakashi-server-work-"));
    const emptyBin = join(workDir, "empty-bin");
    await mkdir(emptyBin, { recursive: true });

    await withRunningServer(
      workDir,
      async (baseUrl) => {
        const createdResponse = await fetch(`${baseUrl}/api/runs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: "interactive",
            requirement: "build a real CLI",
            outputDir: "generated/cli",
            options: { maxRepos: 1 }
          })
        });
        expect(createdResponse.status).toBe(202);
        const created = (await createdResponse.json()) as { runId: string };

        const failed = await waitForRunStage(baseUrl, created.runId, "failed");
        expect(failed.error).toMatch(/GitHub authentication is required/);

        const confirmResponse = await fetch(`${baseUrl}/api/runs/${created.runId}/confirm-plan`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ confirmed: true })
        });
        const confirm = (await confirmResponse.json()) as { error?: string };

        expect(confirmResponse.status).toBe(404);
        expect(confirm.error).toMatch(/not active/i);
      },
      {
        GITHUB_TOKEN: "",
        GH_TOKEN: "",
        GH_CONFIG_DIR: join(workDir, "gh-config"),
        PATH: emptyBin
      }
    );
  });
});

async function withRunningServer(
  workDir: string,
  run: (baseUrl: string) => Promise<void>,
  env: NodeJS.ProcessEnv = {}
): Promise<void> {
  const port = await getOpenPort();
  const serverArgs = [
    join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"),
    "--tsconfig",
    tsconfig,
    serverEntry,
    `--port=${port}`
  ];
  const child = spawn(process.execPath, serverArgs, {
    cwd: workDir,
    env: { ...process.env, ...env, KAKASHI_WEB_DIST: "" }
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

async function waitForRunStage(baseUrl: string, runId: string, stage: string): Promise<{ stage: string; error?: string }> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/runs/${runId}`);
    if (response.ok) {
      const state = (await response.json()) as { stage: string; error?: string };
      if (state.stage === stage) return state;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Run ${runId} did not reach ${stage} within 5 seconds.`);
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

function requirementSpec(): RequirementSpec {
  return {
    raw: "Build a searchable developer tool",
    goal: "Build a searchable developer tool",
    target: "web",
    preferredStack: ["TypeScript"],
    constraints: [],
    capabilities: [
      {
        id: "search",
        name: "Repository Search",
        description: "Search and rank repository content",
        keywords: ["search", "rank"],
        required: true
      }
    ]
  };
}

function repoAnalysis(fullName: string, id: number, capabilityId: string, confidence: number): RepoAnalysis {
  const candidate = repoCandidate(fullName, id);
  return {
    candidate,
    localPath: `/tmp/kakashi-sources/${candidate.name}`,
    stack: ["TypeScript"],
    packageManagers: ["pnpm"],
    manifests: ["package.json"],
    commands: [
      {
        name: "test",
        command: "pnpm test",
        source: "package.json",
        purpose: "test"
      }
    ],
    modules: [
      {
        path: "src/index.ts",
        kind: "source",
        summary: "Core implementation"
      }
    ],
    readmeSummary: `${fullName} README summary`,
    capabilityMatches: [
      {
        capabilityId,
        capabilityName: "Repository Search",
        confidence,
        evidence: [`${fullName} implements search`]
      }
    ],
    risks: []
  };
}

function repoCandidate(fullName: string, id: number): RepoCandidate {
  const [owner, name] = fullName.split("/");
  return {
    id,
    fullName,
    owner: owner ?? "open-source",
    name: name ?? fullName,
    htmlUrl: `https://github.com/${fullName}`,
    cloneUrl: `https://github.com/${fullName}.git`,
    defaultBranch: "main",
    description: `${fullName} description`,
    stars: id * 100,
    forks: id * 10,
    openIssues: 0,
    language: "TypeScript",
    license: "MIT",
    updatedAt: "2026-06-17T00:00:00.000Z",
    pushedAt: "2026-06-17T00:00:00.000Z",
    archived: false,
    fork: false,
    score: 1,
    matchedCapabilities: ["search"]
  };
}
