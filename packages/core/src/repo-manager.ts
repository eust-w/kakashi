import { dirname, join } from "node:path";
import type { RepoCandidate } from "./types";
import { KakashiError } from "./errors";
import { ensureDir, pathExists } from "./utils/fs";
import { runCommand } from "./utils/command";
import { slugify } from "./utils/ids";

export class RepoManager {
  async cloneToCache(candidate: RepoCandidate, cacheDir: string, timeoutMs: number): Promise<string> {
    await ensureDir(cacheDir);
    const repoDir = join(cacheDir, slugify(candidate.fullName));

    if (await pathExists(join(repoDir, ".git"))) {
      await runCommand("git", ["-C", repoDir, "fetch", "--depth", "1", "origin", candidate.defaultBranch], {
        cwd: cacheDir,
        timeoutMs
      });
      return repoDir;
    }

    const result = await runCommand(
      "git",
      ["clone", "--depth", "1", "--branch", candidate.defaultBranch, candidate.cloneUrl, repoDir],
      {
        cwd: cacheDir,
        timeoutMs
      }
    );

    if (result.exitCode !== 0) {
      throw new KakashiError("GIT_CLONE_FAILED", `Failed to clone ${candidate.fullName}.`, result);
    }
    return repoDir;
  }

  async cloneMainToOutput(candidate: RepoCandidate, outputDir: string, timeoutMs: number): Promise<void> {
    const parent = dirname(outputDir);
    const result = await runCommand("git", ["clone", "--depth", "1", candidate.cloneUrl, outputDir], {
      cwd: parent,
      timeoutMs
    });
    if (result.exitCode !== 0) {
      throw new KakashiError("GIT_OUTPUT_CLONE_FAILED", `Failed to materialize ${candidate.fullName}.`, result);
    }
  }

  async cloneAuxiliary(candidate: RepoCandidate, sourcesDir: string, timeoutMs: number): Promise<string> {
    await ensureDir(sourcesDir);
    const dest = join(sourcesDir, slugify(candidate.fullName));
    if (await pathExists(join(dest, ".git"))) return dest;
    const result = await runCommand("git", ["clone", "--depth", "1", candidate.cloneUrl, dest], {
      cwd: sourcesDir,
      timeoutMs
    });
    if (result.exitCode !== 0) {
      throw new KakashiError("GIT_AUX_CLONE_FAILED", `Failed to clone auxiliary repo ${candidate.fullName}.`, result);
    }
    return dest;
  }
}
