import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { KakashiOrchestrator } from "./orchestrator";
import { CodexExecutor } from "./codex-executor";
import { Exporter } from "./exporter";
import { RepoManager } from "./repo-manager";
import { Verifier } from "./verifier";
import type { CodexResult, FusionPlan, RepoCandidate, RunReport, VerificationResult } from "./types";

const execFileAsync = promisify(execFile);
const originalPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = originalPath;
});

describe("KakashiOrchestrator", () => {
  it("skips a repository candidate that cannot be cloned and continues with remaining real candidates", async () => {
    const root = await mkdtemp(join(tmpdir(), "kakashi-orchestrator-"));
    const validRemote = await createVerifiableRemote(root);
    const badCandidate = makeCandidate(validRemote);
    const goodCandidate = {
      ...makeCandidate(validRemote),
      id: 2,
      fullName: "local/good-source",
      name: "good-source"
    };
    badCandidate.fullName = "local/broken-source";
    badCandidate.name = "broken-source";
    badCandidate.defaultBranch = "missing-branch";

    const orchestrator = new KakashiOrchestrator({
      workDir: root,
      outputDir: join(root, "output"),
      cacheDir: join(root, "cache"),
      commandTimeoutMs: 30_000,
      services: {
        searcher: {
          search: async () => [badCandidate, goodCandidate]
        }
      }
    });

    const prepared = await orchestrator.prepare("Build a TypeScript CLI with tests", "interactive");

    expect(prepared.analyses.map((analysis) => analysis.candidate.fullName)).toEqual([goodCandidate.fullName]);
    expect(prepared.plan.main.repo.fullName).toBe(goodCandidate.fullName);
    const events = await orchestrator.store.events(prepared.state.runId);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "warn",
          message: expect.stringContaining("Skipped local/broken-source")
        })
      ])
    );
  });

  it("fails explicitly when no repository candidate can be cloned and analyzed", async () => {
    const root = await mkdtemp(join(tmpdir(), "kakashi-orchestrator-"));
    const validRemote = await createVerifiableRemote(root);
    const badCandidate = makeCandidate(validRemote);
    badCandidate.fullName = "local/broken-source";
    badCandidate.name = "broken-source";
    badCandidate.defaultBranch = "missing-branch";
    const orchestrator = new KakashiOrchestrator({
      workDir: root,
      outputDir: join(root, "output"),
      cacheDir: join(root, "cache"),
      commandTimeoutMs: 30_000,
      services: {
        searcher: {
          search: async () => [badCandidate]
        }
      }
    });

    await expect(orchestrator.prepare("Build a TypeScript CLI with tests", "interactive")).rejects.toMatchObject({
      code: "NO_REPOS_ANALYZED"
    });
  });

  it("exports skipped candidate warnings into the final machine report", async () => {
    const root = await mkdtemp(join(tmpdir(), "kakashi-orchestrator-"));
    const validRemote = await createVerifiableRemote(root);
    const badCandidate = makeCandidate(validRemote);
    const goodCandidate = {
      ...makeCandidate(validRemote),
      id: 2,
      fullName: "local/good-source",
      name: "good-source"
    };
    badCandidate.fullName = "local/broken-source";
    badCandidate.name = "broken-source";
    badCandidate.defaultBranch = "missing-branch";
    const outputDir = join(root, "output");
    const orchestrator = new KakashiOrchestrator({
      workDir: root,
      outputDir,
      cacheDir: join(root, "cache"),
      commandTimeoutMs: 30_000,
      force: false,
      services: {
        searcher: {
          search: async () => [badCandidate, goodCandidate]
        },
        codex: successfulCodex(),
        verifier: successfulVerifier()
      }
    });

    const finalState = await orchestrator.run("Build a TypeScript CLI with tests", "auto");

    expect(finalState.stage).toBe("completed");
    const machineReport = JSON.parse(await readFile(join(outputDir, ".kakashi", "run-report.json"), "utf8")) as RunReport;
    expect(machineReport.runEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "warn",
          message: expect.stringContaining("Skipped local/broken-source")
        })
      ])
    );
  });

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

function successfulCodex(): { execute: () => Promise<CodexResult> } {
  return {
    execute: async () => ({
      ok: true,
      exitCode: 0,
      finalMessage: JSON.stringify({
        summary: "No code changes were required for this verification fixture.",
        changedFiles: [],
        verificationNotes: "Fixture Codex service completed.",
        blockers: []
      }),
      events: [],
      result: {
        command: "codex exec",
        cwd: "",
        exitCode: 0,
        signal: null,
        stdout: "",
        stderr: "",
        durationMs: 1,
        timedOut: false,
        aborted: false
      }
    })
  };
}

function successfulVerifier(): { verify: (projectDir: string) => Promise<VerificationResult> } {
  return {
    verify: async (projectDir: string) => ({
      ok: true,
      summary: "Verification passed 1 detected step(s).",
      steps: [
        {
          name: "fixture verify",
          command: "node -e true",
          ok: true,
          result: {
            command: "node -e true",
            cwd: projectDir,
            exitCode: 0,
            signal: null,
            stdout: "",
            stderr: "",
            durationMs: 1,
            timedOut: false,
            aborted: false
          }
        }
      ]
    })
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
