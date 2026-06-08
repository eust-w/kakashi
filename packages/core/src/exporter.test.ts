import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { Exporter } from "./exporter";
import type { CodexResult, FusionPlan, RepoAnalysis, RepoCandidate, VerificationResult } from "./types";

const candidate: RepoCandidate = {
  id: 1,
  fullName: "example/main-app",
  owner: "example",
  name: "main-app",
  htmlUrl: "https://github.com/example/main-app",
  cloneUrl: "https://github.com/example/main-app.git",
  defaultBranch: "main",
  description: "Main app with dashboard",
  stars: 100,
  forks: 5,
  openIssues: 1,
  sizeKb: 120,
  language: "TypeScript",
  license: "MIT",
  updatedAt: "2026-01-01T00:00:00Z",
  pushedAt: "2026-01-01T00:00:00Z",
  archived: false,
  fork: false,
  score: 42,
  matchedCapabilities: ["dashboard"]
};

describe("Exporter", () => {
  it("writes a full human-readable process report", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "kakashi-export-"));
    const analysis: RepoAnalysis = {
      candidate,
      localPath: outputDir,
      stack: ["typescript", "react"],
      packageManagers: ["pnpm"],
      manifests: ["package.json"],
      commands: [{ name: "build", command: "pnpm run build", source: "package.json", purpose: "build" }],
      modules: [{ path: "src", kind: "source", summary: "App.tsx, api.ts" }],
      readmeSummary: "A dashboard project.",
      capabilityMatches: [
        {
          capabilityId: "dashboard",
          capabilityName: "dashboard",
          confidence: 0.9,
          evidence: ["dashboard", "react"]
        }
      ],
      risks: []
    };
    const plan: FusionPlan = {
      requirement: {
        raw: "Build a dashboard",
        goal: "Build a dashboard",
        target: "web",
        preferredStack: ["react"],
        capabilities: [
          {
            id: "dashboard",
            name: "dashboard",
            description: "dashboard UI",
            keywords: ["dashboard"],
            required: true
          }
        ],
        constraints: ["no mock, fake, simulated, or hardcoded success paths"]
      },
      graph: {
        capabilities: [
          {
            id: "dashboard",
            name: "dashboard",
            description: "dashboard UI",
            keywords: ["dashboard"],
            required: true
          }
        ],
        repos: [analysis],
        edges: [
          {
            capabilityId: "dashboard",
            repoFullName: candidate.fullName,
            confidence: 0.9,
            evidence: ["dashboard"]
          }
        ],
        gaps: []
      },
      main: {
        role: "main",
        repo: candidate,
        localPath: outputDir,
        providedCapabilities: ["dashboard"],
        rationale: "best dashboard coverage"
      },
      auxiliaries: [],
      tasks: [
        {
          title: "Fuse dashboard",
          prompt: "Implement dashboard",
          successCriteria: ["dashboard runs"]
        }
      ],
      verifierCommands: [{ name: "build", command: "pnpm run build", source: "package.json", purpose: "build" }],
      outputDir,
      createdAt: "2026-01-01T00:00:00Z"
    };
    const verification: VerificationResult = {
      ok: true,
      summary: "Verification passed.",
      steps: [
        {
          name: "pnpm build",
          command: "pnpm run build",
          ok: true,
          result: {
            command: "pnpm run build",
            cwd: outputDir,
            exitCode: 0,
            signal: null,
            stdout: "",
            stderr: "",
            durationMs: 100,
            timedOut: false
          }
        }
      ]
    };
    const codexRun: CodexResult = {
      ok: true,
      exitCode: 0,
      finalMessage: JSON.stringify({
        summary: "Created dashboard.",
        changedFiles: ["src/App.tsx"],
        verificationNotes: "Build passed.",
        blockers: []
      }),
      events: [],
      result: {
        command: "codex exec",
        cwd: outputDir,
        exitCode: 0,
        signal: null,
        stdout: "",
        stderr: "",
        durationMs: 500,
        timedOut: false
      }
    };

    await new Exporter().exportReport("run_test", plan, verification, [codexRun], [verification]);
    const report = await readFile(join(outputDir, "KAKASHI_REPORT.md"), "utf8");

    expect(report).toContain("# Kakashi Full Process Report");
    expect(report).toContain("## GitHub Projects Analyzed");
    expect(report).toContain("example/main-app (main)");
    expect(report).toContain("## Selected Fusion Sources");
    expect(report).toContain("## Capability Collection Scope");
    expect(report).toContain("## Verification and Repair Loop");
    expect(report).toContain("No repair loop was needed");
  });
});
