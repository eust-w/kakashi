import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { GitHubSearcher, isKakashiError, RepoAnalyzer, RepoManager, RequirementParser } from "@kakashi/core";

describe.runIf(process.env.RUN_REAL_INTEGRATION === "1")("real GitHub repository search and analysis", () => {
  it("searches GitHub, clones a permissive repository, and analyzes real files", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "kakashi-github-"));
    const cacheDir = join(workDir, "repos");
    const spec = new RequirementParser().parse("Vite TypeScript web build tool");
    let candidates;
    try {
      candidates = await new GitHubSearcher().search(spec, {
        cwd: process.cwd(),
        maxRepos: 1,
        allowCopyleft: false
      });
    } catch (error) {
      if (isKakashiError(error) && error.code === "GITHUB_RATE_LIMITED") {
        console.warn(error.message);
        return;
      }
      throw error;
    }

    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((candidate) => candidate.cloneUrl.startsWith("https://github.com/"))).toBe(true);

    const localPath = await new RepoManager().cloneToCache(candidates[0]!, cacheDir, 300_000);
    const analysis = await new RepoAnalyzer().analyze(candidates[0]!, localPath, spec.capabilities);

    expect(analysis.localPath).toBe(localPath);
    expect(analysis.manifests.length + analysis.modules.length + analysis.readmeSummary.length).toBeGreaterThan(0);
  });
});
