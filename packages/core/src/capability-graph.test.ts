import { describe, expect, it } from "vitest";
import { CapabilityGraphBuilder } from "./capability-graph";
import type { Capability, RepoAnalysis, RepoCandidate } from "./types";

const capability: Capability = {
  id: "github-search",
  name: "GitHub search",
  description: "search repositories",
  keywords: ["github", "search"],
  required: true
};

const candidate: RepoCandidate = {
  id: 1,
  fullName: "owner/repo",
  owner: "owner",
  name: "repo",
  htmlUrl: "https://github.com/owner/repo",
  cloneUrl: "https://github.com/owner/repo.git",
  defaultBranch: "main",
  description: "Repository search",
  stars: 10,
  forks: 1,
  openIssues: 0,
  sizeKb: 100,
  language: "TypeScript",
  license: "MIT",
  updatedAt: "2026-01-01T00:00:00Z",
  pushedAt: "2026-01-01T00:00:00Z",
  archived: false,
  fork: false,
  score: 10,
  matchedCapabilities: []
};

describe("CapabilityGraphBuilder", () => {
  it("links repos to capabilities and reports low-confidence gaps", () => {
    const analyses: RepoAnalysis[] = [
      {
        candidate,
        localPath: "/tmp/repo",
        stack: ["typescript"],
        packageManagers: ["pnpm"],
        manifests: ["package.json"],
        commands: [],
        modules: [],
        readmeSummary: "GitHub search",
        capabilityMatches: [
          {
            capabilityId: capability.id,
            capabilityName: capability.name,
            confidence: 0.8,
            evidence: ["github"]
          }
        ],
        risks: []
      }
    ];

    const graph = new CapabilityGraphBuilder().build([capability], analyses);

    expect(graph.edges).toHaveLength(1);
    expect(graph.gaps).toHaveLength(0);
  });
});
