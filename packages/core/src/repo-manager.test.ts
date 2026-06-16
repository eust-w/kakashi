import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { RepoManager } from "./repo-manager";
import type { KakashiError } from "./errors";
import type { RepoCandidate } from "./types";

const execFileAsync = promisify(execFile);

describe("RepoManager", () => {
  it("fails instead of reusing stale cache when refreshing a cached repo fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "kakashi-repo-manager-"));
    const remote = await createLocalRemote(root);
    const cache = join(root, "cache");
    const manager = new RepoManager();
    const candidate = makeCandidate(remote, "main");

    await expect(manager.cloneToCache(candidate, cache, 30_000)).resolves.toContain("owner-project");

    await expect(manager.cloneToCache(makeCandidate(remote, "missing-branch"), cache, 30_000)).rejects.toMatchObject({
      code: "GIT_FETCH_FAILED"
    } satisfies Partial<KakashiError>);
  });

  it("fails instead of reusing stale auxiliary sources when refreshing an existing auxiliary repo fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "kakashi-repo-manager-"));
    const remote = await createLocalRemote(root);
    const sources = join(root, "sources");
    const manager = new RepoManager();
    const candidate = makeCandidate(remote, "main");

    await expect(manager.cloneAuxiliary(candidate, sources, 30_000)).resolves.toContain("owner-project");

    await expect(manager.cloneAuxiliary(makeCandidate(remote, "missing-branch"), sources, 30_000)).rejects.toMatchObject({
      code: "GIT_FETCH_FAILED"
    } satisfies Partial<KakashiError>);
  });

  it("materializes the selected candidate branch into the output directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "kakashi-repo-manager-"));
    const remote = await createLocalRemote(root);
    const output = join(root, "output");
    const manager = new RepoManager();

    await runGit(["-C", remote, "checkout", "-b", "feature-source"], root);
    await writeFile(join(remote, "FEATURE.md"), "# selected branch\n", "utf8");
    await runGit(["-C", remote, "add", "FEATURE.md"], root);
    await runGit(["-C", remote, "-c", "user.name=Kakashi Test", "-c", "user.email=kakashi@example.test", "commit", "-m", "feature"], root);
    await runGit(["-C", remote, "checkout", "main"], root);

    await manager.cloneMainToOutput(makeCandidate(remote, "feature-source"), output, 30_000);

    await expect(readFile(join(output, "FEATURE.md"), "utf8")).resolves.toContain("selected branch");
  });
});

function makeCandidate(cloneUrl: string, defaultBranch: string): RepoCandidate {
  return {
    id: 1,
    fullName: "owner/project",
    owner: "owner",
    name: "project",
    htmlUrl: cloneUrl,
    cloneUrl,
    defaultBranch,
    description: "local real git repository",
    stars: 0,
    forks: 0,
    openIssues: 0,
    language: null,
    license: "MIT",
    updatedAt: new Date(0).toISOString(),
    pushedAt: new Date(0).toISOString(),
    archived: false,
    fork: false,
    score: 0,
    matchedCapabilities: []
  };
}

async function runGit(args: string[], cwd: string): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function createLocalRemote(root: string): Promise<string> {
  const remote = join(root, "remote");
  await runGit(["init", "--initial-branch=main", remote], root);
  await writeFile(join(remote, "README.md"), "# real source\n", "utf8");
  await runGit(["-C", remote, "add", "README.md"], root);
  await runGit(["-C", remote, "-c", "user.name=Kakashi Test", "-c", "user.email=kakashi@example.test", "commit", "-m", "initial"], root);
  return remote;
}
