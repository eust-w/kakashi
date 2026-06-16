import { dirname, join } from "node:path";
import type { RepoCandidate } from "./types";
import { KakashiError } from "./errors";
import { ensureDir, pathExists } from "./utils/fs";
import { runCommand } from "./utils/command";
import { slugify } from "./utils/ids";

export class RepoManager {
  async cloneToCache(candidate: RepoCandidate, cacheDir: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
    await ensureDir(cacheDir);
    const repoDir = join(cacheDir, slugify(candidate.fullName));

    if (await pathExists(join(repoDir, ".git"))) {
      await this.refreshCachedRepo(candidate, repoDir, cacheDir, timeoutMs, signal);
      return repoDir;
    }

    const result = await runCommand(
      "git",
      ["clone", "--depth", "1", "--branch", candidate.defaultBranch, candidate.cloneUrl, repoDir],
      {
        cwd: cacheDir,
        timeoutMs,
        signal
      }
    );

    if (result.exitCode !== 0) {
      throw new KakashiError("GIT_CLONE_FAILED", `Failed to clone ${candidate.fullName}.`, result);
    }
    return repoDir;
  }

  async cloneMainToOutput(candidate: RepoCandidate, outputDir: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const parent = dirname(outputDir);
    const result = await runCommand("git", ["clone", "--depth", "1", "--branch", candidate.defaultBranch, candidate.cloneUrl, outputDir], {
      cwd: parent,
      timeoutMs,
      signal
    });
    if (result.exitCode !== 0) {
      throw new KakashiError("GIT_OUTPUT_CLONE_FAILED", `Failed to materialize ${candidate.fullName}.`, result);
    }
  }

  async cloneAuxiliary(candidate: RepoCandidate, sourcesDir: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
    await ensureDir(sourcesDir);
    const dest = join(sourcesDir, slugify(candidate.fullName));
    if (await pathExists(join(dest, ".git"))) {
      await this.refreshCachedRepo(candidate, dest, sourcesDir, timeoutMs, signal);
      return dest;
    }
    const result = await runCommand("git", ["clone", "--depth", "1", "--branch", candidate.defaultBranch, candidate.cloneUrl, dest], {
      cwd: sourcesDir,
      timeoutMs,
      signal
    });
    if (result.exitCode !== 0) {
      throw new KakashiError("GIT_AUX_CLONE_FAILED", `Failed to clone auxiliary repo ${candidate.fullName}.`, result);
    }
    return dest;
  }

  private async refreshCachedRepo(
    candidate: RepoCandidate,
    repoDir: string,
    cwd: string,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<void> {
    const result = await runCommand("git", ["-C", repoDir, "fetch", "--depth", "1", "origin", candidate.defaultBranch], {
      cwd,
      timeoutMs,
      signal
    });
    if (result.exitCode !== 0) {
      throw new KakashiError("GIT_FETCH_FAILED", `Failed to refresh cached repo ${candidate.fullName}.`, result);
    }
  }
}
