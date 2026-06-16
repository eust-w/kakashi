import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { pathExists } from "../packages/core/src/utils/fs";

describe("open-source project health", () => {
  it("keeps standard community health files in supported GitHub locations", async () => {
    const expectedFiles = [
      "CODE_OF_CONDUCT.md",
      "SUPPORT.md",
      ".github/PULL_REQUEST_TEMPLATE.md",
      ".github/ISSUE_TEMPLATE/bug_report.yml",
      ".github/ISSUE_TEMPLATE/feature_request.yml",
      ".github/ISSUE_TEMPLATE/config.yml",
      ".github/dependabot.yml"
    ];

    for (const file of expectedFiles) {
      await expect(pathExists(file), file).resolves.toBe(true);
    }
  });

  it("uses explicit minimal workflow token permissions", async () => {
    const ci = await readFile(".github/workflows/ci.yml", "utf8");
    const release = await readFile(".github/workflows/release.yml", "utf8");

    expect(ci).toContain("permissions:\n  contents: read");
    expect(release).toContain("permissions:\n  contents: write");
  });
});
