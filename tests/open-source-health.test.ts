import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { pathExists } from "../packages/core/src/utils/fs";
import packageJson from "../package.json";

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

  it("keeps a high-severity dependency audit in the standard verification path", async () => {
    const ci = await readFile(".github/workflows/ci.yml", "utf8");
    const release = await readFile(".github/workflows/release.yml", "utf8");

    expect(packageJson.scripts).toHaveProperty("audit:high", "pnpm audit --audit-level high");
    expect(packageJson.devDependencies.esbuild).toMatch(/^\^0\.28\./);
    expect(ci).toContain("pnpm audit:high");
    expect(release).toContain("pnpm audit:high");
  });

  it("uses workflow concurrency to avoid duplicate same-ref runs", async () => {
    const ci = await readFile(".github/workflows/ci.yml", "utf8");
    const release = await readFile(".github/workflows/release.yml", "utf8");

    expect(ci).toContain("concurrency:");
    expect(ci).toContain("cancel-in-progress: true");
    expect(release).toContain("concurrency:");
    expect(release).toContain("cancel-in-progress: false");
  });

  it("executes built release CLI assets before publishing them", async () => {
    const release = await readFile(".github/workflows/release.yml", "utf8");

    expect(packageJson.scripts).toHaveProperty("verify:release-assets", "node scripts/verify-release-assets.mjs");
    await expect(pathExists("scripts/verify-release-assets.mjs")).resolves.toBe(true);
    expect(release).toContain("Verify built CLI assets");
    expect(release).toContain("pnpm verify:release-assets");
  });
});
