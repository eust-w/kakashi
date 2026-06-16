import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { KakashiOrchestrator } from "./orchestrator";
import { CodexExecutor } from "./codex-executor";
import { Exporter } from "./exporter";
import { RepoManager } from "./repo-manager";
import { Verifier } from "./verifier";
import type { FusionPlan, RepoCandidate } from "./types";

const execFileAsync = promisify(execFile);
const originalPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = originalPath;
});

describe("KakashiOrchestrator", () => {
  it("fails the run when Codex exits non-zero even if the cloned project verifies", async () => {
    const root = await mkdtemp(join(tmpdir(), "kakashi-orchestrator-"));
    const remote = await createVerifiableRemote(root);
    const failingCodexBin = join(root, "bin");
    await mkdir(failingCodexBin, { recursive: true });
    await writeFileExecutable(
      join(failingCodexBin, "codex"),
      "#!/bin/sh\necho '{\"type\":\"error\",\"message\":\"codex failed\"}'\necho 'codex failed before changing files' >&2\nexit 7\n"
    );
    process.env.PATH = [failingCodexBin, originalPath].filter(Boolean).join(delimiter);

    const outputDir = join(root, "output");
    const plan = createPlan(outputDir, makeCandidate(remote));
    const orchestrator = new KakashiOrchestrator({
      workDir: root,
      outputDir,
      cacheDir: join(root, "cache"),
      maxIterations: 1,
      commandTimeoutMs: 30_000,
      force: false,
      services: {
        repoManager: new RepoManager(),
        codex: new CodexExecutor(),
        verifier: new Verifier(),
        exporter: new Exporter()
      }
    });
    const state = await orchestrator.createState("Keep this project working", "auto");

    const finalState = await orchestrator.executePrepared(state, plan);

    expect(finalState.stage).toBe("failed");
    expect(finalState.error).toContain("Codex execution failed");
    expect(finalState.report?.codexRuns).toHaveLength(1);
    expect(finalState.report?.codexRuns[0]?.ok).toBe(false);
    expect(finalState.report?.verification.summary).toContain("Codex execution failed");
  });
});

function makeCandidate(cloneUrl: string): RepoCandidate {
  return {
    id: 1,
    fullName: "local/verifiable",
    owner: "local",
    name: "verifiable",
    htmlUrl: cloneUrl,
    cloneUrl,
    defaultBranch: "main",
    description: "local verifiable project",
    stars: 0,
    forks: 0,
    openIssues: 0,
    sizeKb: 1,
    language: "TypeScript",
    license: "MIT",
    updatedAt: new Date(0).toISOString(),
    pushedAt: new Date(0).toISOString(),
    archived: false,
    fork: false,
    score: 0,
    matchedCapabilities: ["working-project"]
  };
}

function createPlan(outputDir: string, candidate: RepoCandidate): FusionPlan {
  const capability = {
    id: "working-project",
    name: "working project",
    description: "project verifies with real commands",
    keywords: ["working"],
    required: true
  };
  return {
    requirement: {
      raw: "Keep this project working",
      goal: "Keep this project working",
      target: "cli",
      preferredStack: ["node"],
      capabilities: [capability],
      constraints: ["codex execution must succeed"]
    },
    graph: { capabilities: [capability], repos: [], edges: [], gaps: [] },
    main: {
      role: "main",
      repo: candidate,
      localPath: "",
      providedCapabilities: [capability.id],
      rationale: "local test repository"
    },
    auxiliaries: [],
    tasks: [
      {
        title: "preserve verification",
        prompt: "Keep the package test passing.",
        successCriteria: ["codex exits successfully", "npm test passes"]
      }
    ],
    verifierCommands: [],
    outputDir,
    createdAt: new Date(0).toISOString()
  };
}

async function createVerifiableRemote(root: string): Promise<string> {
  const remote = join(root, "remote");
  await runGit(["init", "--initial-branch=main", remote], root);
  await writeFile(
    join(remote, "package.json"),
    JSON.stringify({
      scripts: {
        test: "node -e \"console.log('verified')\""
      }
    }),
    "utf8"
  );
  await runGit(["-C", remote, "add", "package.json"], root);
  await runGit(["-C", remote, "-c", "user.name=Kakashi Test", "-c", "user.email=kakashi@example.test", "commit", "-m", "initial"], root);
  return remote;
}

async function writeFileExecutable(path: string, content: string): Promise<void> {
  await writeFile(path, content, "utf8");
  await chmod(path, 0o755);
}

async function runGit(args: string[], cwd: string): Promise<void> {
  await execFileAsync("git", args, { cwd });
}
