import { describe, expect, it } from "vitest";
import { explainRepositoryScore } from "./repository-score";
import type { RequirementSpec } from "./types";

const spec: RequirementSpec = {
  raw: "Build a TypeScript dashboard with tests",
  goal: "Build a TypeScript dashboard with tests",
  target: "web",
  preferredStack: ["typescript"],
  capabilities: [
    {
      id: "dashboard",
      name: "dashboard",
      description: "dashboard UI",
      keywords: ["dashboard", "ui"],
      required: true
    }
  ],
  constraints: []
};

describe("explainRepositoryScore", () => {
  it("returns a score breakdown and human-readable reason", () => {
    const explanation = explainRepositoryScore(
      {
        stargazers_count: 100,
        forks_count: 10,
        open_issues_count: 2,
        pushed_at: new Date().toISOString(),
        language: "TypeScript",
        full_name: "example/dashboard-kit",
        name: "dashboard-kit",
        description: "TypeScript web dashboard components",
        size: 512
      },
      1,
      spec
    );

    expect(explanation.total).toBeGreaterThan(0);
    expect(explanation.breakdown.directTermHits).toBeGreaterThan(0);
    expect(explanation.breakdown.stackBoost).toBeGreaterThan(0);
    expect(explanation.reason).toContain("direct term hits");
    expect(explanation.reason).toContain("stack match");
  });
});
