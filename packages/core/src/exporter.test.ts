import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { Exporter } from "./exporter";
import type { CodexResult, FusionPlan, RepoAnalysis, RepoCandidate, RunEvent, VerificationResult } from "./types";

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
    const plan = createPlan(outputDir);
    const verification = createVerification(outputDir);
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
        timedOut: false,
        aborted: false
      }
    };

    await new Exporter().exportReport("run_test", plan, verification, [codexRun], [verification]);
    const report = await readFile(join(outputDir, "KAKASHI_REPORT.md"), "utf8");

    expect(report).toContain("# Kakashi 完整流程报告 / Full Process Report");
    expect(report).toContain("## 已分析的 GitHub 项目 / GitHub Projects Analyzed");
    expect(report).toContain("example/main-app (main)");
    expect(report).toContain("## 选中的融合来源 / Selected Fusion Sources");
    expect(report).toContain("## 能力采集范围 / Capability Collection Scope");
    expect(report).toContain("## 验证和修复回环 / Verification and Repair Loop");
    expect(report).toContain("无需修复回环");
    expect(report).toContain("No repair loop was needed");
  });

  it("redacts secrets from exported reports and generated project README", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "kakashi-export-"));
    const secret = "secret-value-12345";
    const accessToken = "codex-access-token-12345";
    const plan = createPlan(outputDir, `Build a dashboard with token: ${secret}`);
    const verification = createVerification(outputDir, `Verification used password: ${secret}`);
    const runEvent: RunEvent = {
      id: "event_secret",
      runId: "run_test",
      timestamp: "2026-06-17T00:00:00.000Z",
      stage: "executing",
      level: "warn",
      message: `Retrying request with api_key: ${secret} and Authorization: Bearer ${accessToken}`
    };
    const codexRun: CodexResult = {
      ok: true,
      exitCode: 0,
      finalMessage: JSON.stringify({
        summary: `Created dashboard with access_token: ${accessToken}`,
        changedFiles: ["src/App.tsx"],
        verificationNotes: `Checked api_key: ${secret}`,
        blockers: []
      }),
      events: [{ message: `Authorization: Bearer ${accessToken}` }],
      result: {
        command: "codex exec",
        cwd: outputDir,
        exitCode: 0,
        signal: null,
        stdout: `api_key: ${secret}`,
        stderr: `Authorization: Bearer ${accessToken}`,
        durationMs: 500,
        timedOut: false,
        aborted: false
      }
    };

    const returnedReport = await new Exporter().exportReport("run_test", plan, verification, [codexRun], [verification], [runEvent]);

    const markdownReport = await readFile(join(outputDir, "KAKASHI_REPORT.md"), "utf8");
    const machineReport = await readFile(join(outputDir, ".kakashi", "run-report.json"), "utf8");
    const generatedReadme = await readFile(join(outputDir, "README.md"), "utf8");
    const provenance = await readFile(join(outputDir, "SOURCE_PROVENANCE.json"), "utf8");

    for (const content of [markdownReport, machineReport, generatedReadme, provenance, JSON.stringify(returnedReport)]) {
      expect(content).toContain("[REDACTED]");
      expect(content).not.toContain(secret);
      expect(content).not.toContain(accessToken);
    }
  });

  it("includes important run events in machine and markdown reports", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "kakashi-export-"));
    const plan = createPlan(outputDir);
    const verification = createVerification(outputDir);
    const runEvent: RunEvent = {
      id: "event_1",
      runId: "run_test",
      timestamp: "2026-06-17T00:00:00.000Z",
      stage: "analyzing",
      level: "warn",
      message: "Skipped example/broken-source: Failed to clone example/broken-source."
    };

    await new Exporter().exportReport("run_test", plan, verification, [], [verification], [runEvent]);

    const markdownReport = await readFile(join(outputDir, "KAKASHI_REPORT.md"), "utf8");
    const machineReport = JSON.parse(await readFile(join(outputDir, ".kakashi", "run-report.json"), "utf8")) as {
      runEvents?: RunEvent[];
    };

    expect(machineReport.runEvents).toEqual([runEvent]);
    expect(markdownReport).toContain("## 运行事件 / Run Events");
    expect(markdownReport).toContain("WARN analyzing: Skipped example/broken-source");
  });
});

function createPlan(outputDir: string, rawRequirement = "Build a dashboard"): FusionPlan {
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
  return {
    requirement: {
      raw: rawRequirement,
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
}

function createVerification(outputDir: string, summary = "Verification passed."): VerificationResult {
  return {
    ok: true,
    summary,
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
          timedOut: false,
          aborted: false
        }
      }
    ]
  };
}
