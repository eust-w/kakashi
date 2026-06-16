import { describe, expect, it } from "vitest";
import { applyInteractiveSelection } from "./interactive-selection";
import type { KakashiRunState, RepoAnalysis, RepoCandidate, RequirementSpec } from "./types";

describe("applyInteractiveSelection", () => {
  it("rebuilds the graph and fusion plan from selected analyzed repositories", () => {
    const state = interactiveState();
    const selected = state.analyses![1]!.candidate.fullName;

    const updated = applyInteractiveSelection(state, [selected]);

    expect(updated.graph?.repos.map((analysis) => analysis.candidate.fullName)).toEqual([selected]);
    expect(updated.graph?.edges.map((edge) => edge.repoFullName)).toEqual([selected]);
    expect(updated.plan?.main.repo.fullName).toBe(selected);
    expect(updated.plan?.auxiliaries).toHaveLength(0);
    expect(updated.plan?.outputDir).toBe(state.outputDir);
  });

  it("can use the plan requirement when the parsed spec is not present", () => {
    const state = interactiveState();
    const selected = state.analyses![0]!.candidate.fullName;
    const planned = applyInteractiveSelection(state, [selected]);
    const stateWithoutSpec: KakashiRunState = { ...state, spec: undefined, plan: planned.plan };

    const updated = applyInteractiveSelection(stateWithoutSpec, [selected]);

    expect(updated.plan?.requirement).toBe(planned.plan?.requirement);
    expect(updated.plan?.main.repo.fullName).toBe(selected);
  });

  it("rejects repository selection outside interactive confirmation", () => {
    const state = interactiveState();

    expect(() => applyInteractiveSelection({ ...state, mode: "auto" }, [state.analyses![0]!.candidate.fullName])).toThrow(
      /interactive runs/
    );
    expect(() => applyInteractiveSelection({ ...state, stage: "planning" }, [state.analyses![0]!.candidate.fullName])).toThrow(
      /plan is ready/
    );
  });

  it("rejects selection before requirement parsing or repository analysis finishes", () => {
    const state = interactiveState();

    expect(() =>
      applyInteractiveSelection({ ...state, spec: undefined, plan: undefined }, [state.analyses![0]!.candidate.fullName])
    ).toThrow(/requirement parsing/);
    expect(() => applyInteractiveSelection({ ...state, analyses: [] }, [state.analyses![0]!.candidate.fullName])).toThrow(
      /repository analysis/
    );
  });

  it("rejects missing or empty analyzed repository selections", () => {
    const state = interactiveState();

    expect(() => applyInteractiveSelection(state, ["missing/repo"])).toThrow(/selected repository/i);
    expect(() => applyInteractiveSelection(state, [])).toThrow(/at least one/i);
  });
});

function interactiveState(): KakashiRunState {
  const now = new Date().toISOString();
  const requirement = requirementSpec();
  const primaryAnalysis = repoAnalysis("open-source/primary", 1, "search", 0.92);
  const auxiliaryAnalysis = repoAnalysis("open-source/auxiliary", 2, "search", 0.84);
  return {
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
