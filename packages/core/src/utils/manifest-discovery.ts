import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const DEFAULT_MANIFEST_NAMES = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
  "pyproject.toml",
  "requirements.txt",
  "go.mod",
  "Cargo.toml",
  "Gemfile",
  "composer.json",
  "Dockerfile"
]);
const DEFAULT_SKIPPED_DIRS = new Set([
  ".git",
  ".kakashi",
  ".cache",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules"
]);

export interface ManifestDiscoveryOptions {
  maxDepth?: number;
  manifestNames?: ReadonlySet<string>;
  skippedDirs?: ReadonlySet<string>;
}

export async function discoverManifests(rootPath: string, options: ManifestDiscoveryOptions = {}): Promise<string[]> {
  const found: string[] = [];
  await collectManifests(rootPath, rootPath, 0, found, {
    maxDepth: options.maxDepth ?? 3,
    manifestNames: options.manifestNames ?? DEFAULT_MANIFEST_NAMES,
    skippedDirs: options.skippedDirs ?? DEFAULT_SKIPPED_DIRS
  });
  return found.sort((a, b) => manifestSortKey(a).localeCompare(manifestSortKey(b)));
}

async function collectManifests(
  rootPath: string,
  dir: string,
  depth: number,
  found: string[],
  options: Required<ManifestDiscoveryOptions>
): Promise<void> {
  if (depth > options.maxDepth) return;
  for (const entry of await safeReadDirEntries(dir)) {
    const path = join(dir, entry.name);
    if (entry.isFile() && options.manifestNames.has(entry.name)) {
      found.push(relative(rootPath, path).split(sep).join("/"));
      continue;
    }
    if (!entry.isDirectory() || entry.name.startsWith(".") || options.skippedDirs.has(entry.name)) continue;
    await collectManifests(rootPath, path, depth + 1, found, options);
  }
}

function manifestSortKey(path: string): string {
  const depth = path.split("/").length;
  return `${String(depth).padStart(2, "0")}:${path}`;
}

async function safeReadDirEntries(path: string): Promise<import("node:fs").Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}
