import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { CodexExecutor, runCommand, type FusionPlan } from "@kakashi/core";

describe.runIf(process.env.RUN_CODEX_INTEGRATION === "1")("real Codex CLI execution", () => {
  it("runs codex exec in a temporary project and returns structured output", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kakashi-codex-"));
    await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "node -e \"console.log('ok')\"" } }), "utf8");
    await runCommand("git", ["init"], { cwd, timeoutMs: 30_000 });

    const plan: FusionPlan = {
      requirement: {
        raw: "Create a small project note file",
        goal: "Create a small project note file",
        target: "unknown",
        preferredStack: [],
        capabilities: [
          {
            id: "note",
            name: "project note",
            description: "write a note",
            keywords: ["note"],
            required: true
          }
        ],
        constraints: []
      },
      graph: { capabilities: [], repos: [], edges: [], gaps: [] },
      main: {
        role: "main",
        repo: {
          id: 1,
          fullName: "local/temp",
          owner: "local",
          name: "temp",
          htmlUrl: "https://github.com/local/temp",
          cloneUrl: "https://github.com/local/temp.git",
          defaultBranch: "main",
          description: "",
          stars: 0,
          forks: 0,
          openIssues: 0,
          sizeKb: 1,
          language: "TypeScript",
          license: "MIT",
          updatedAt: new Date().toISOString(),
          pushedAt: new Date().toISOString(),
          archived: false,
          fork: false,
          score: 0,
          matchedCapabilities: []
        },
        localPath: cwd,
        providedCapabilities: ["note"],
        rationale: "temporary integration project"
      },
      auxiliaries: [],
      tasks: [
        {
          title: "write note",
          prompt: "Create CODEX_NOTE.md with a one-sentence note.",
          successCriteria: ["CODEX_NOTE.md exists"]
        }
      ],
      verifierCommands: [],
      outputDir: cwd,
      createdAt: new Date().toISOString()
    };

    const result = await new CodexExecutor().execute(plan, "Create CODEX_NOTE.md and do not edit package.json.", {
      cwd,
      timeoutMs: 600_000
    });

    expect(result.ok, `${result.result.stderr}\n${result.result.stdout}`).toBe(true);
    expect(result.finalMessage.length).toBeGreaterThan(0);
  });
});
