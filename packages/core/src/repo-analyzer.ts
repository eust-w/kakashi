import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type {
  Capability,
  RepoAnalysis,
  RepoCandidate,
  RepoCapabilityMatch,
  RepoCommand,
  RepoModule
} from "./types";
import { pathExists, readJsonFile } from "./utils/fs";
import { discoverManifests } from "./utils/manifest-discovery";

interface PackageJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  packageManager?: string;
}

const README_NAMES = ["README.md", "README.MD", "readme.md", "README", "docs/README.md"];

export class RepoAnalyzer {
  async analyze(candidate: RepoCandidate, localPath: string, capabilities: Capability[]): Promise<RepoAnalysis> {
    const manifests = await this.detectManifests(localPath);
    const readme = await this.readReadme(localPath);
    const stack = await this.detectStack(localPath, candidate, manifests);
    const packageManagers = await this.detectPackageManagers(localPath, manifests);
    const commands = await this.detectCommands(localPath, manifests);
    const modules = await this.detectModules(localPath);
    const capabilityMatches = this.matchCapabilities(capabilities, readme, modules, manifests, candidate);
    const risks = this.detectRisks(manifests, commands, readme);

    return {
      candidate,
      localPath,
      stack,
      packageManagers,
      manifests,
      commands,
      modules,
      readmeSummary: summarize(readme),
      capabilityMatches,
      risks
    };
  }

  private async detectManifests(localPath: string): Promise<string[]> {
    return await discoverManifests(localPath);
  }

  private async readReadme(localPath: string): Promise<string> {
    for (const name of README_NAMES) {
      const path = join(localPath, name);
      if (await pathExists(path)) {
        return (await readFile(path, "utf8")).slice(0, 50_000);
      }
    }
    return "";
  }

  private async detectStack(localPath: string, candidate: RepoCandidate, manifests: string[]): Promise<string[]> {
    const stack = new Set<string>();
    if (candidate.language) stack.add(candidate.language.toLowerCase());
    for (const manifest of manifests) {
      if (manifest.endsWith("package.json")) {
        stack.add("node");
        const pkg = await readJsonFile<PackageJson>(join(localPath, manifest));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        for (const dep of Object.keys(deps)) {
          if (dep === "react") stack.add("react");
          if (dep === "next") stack.add("nextjs");
          if (dep === "vue") stack.add("vue");
          if (dep === "svelte") stack.add("svelte");
          if (dep === "typescript") stack.add("typescript");
          if (dep === "express") stack.add("express");
          if (dep === "vite") stack.add("vite");
          if (dep === "electron") stack.add("electron");
        }
      }
      if (manifest.endsWith("pyproject.toml") || manifest.endsWith("requirements.txt")) stack.add("python");
      if (manifest.endsWith("go.mod")) stack.add("go");
      if (manifest.endsWith("Cargo.toml")) stack.add("rust");
      if (manifest.endsWith("Dockerfile")) stack.add("docker");
    }
    return [...stack].sort();
  }

  private async detectPackageManagers(localPath: string, manifests: string[]): Promise<string[]> {
    const managers = new Set<string>();
    for (const manifest of manifests) {
      if (manifest.endsWith("package.json")) {
        const pkg = await readJsonFile<PackageJson>(join(localPath, manifest));
        managers.add(await detectNodeManagerForManifest(localPath, manifest, pkg));
      }
      if (manifest.endsWith("pyproject.toml")) managers.add("python");
      if (manifest.endsWith("requirements.txt")) managers.add("pip");
      if (manifest.endsWith("go.mod")) managers.add("go");
      if (manifest.endsWith("Cargo.toml")) managers.add("cargo");
    }
    return [...managers];
  }

  private async detectCommands(localPath: string, manifests: string[]): Promise<RepoCommand[]> {
    const commands: RepoCommand[] = [];
    for (const manifest of manifests.filter((manifest) => manifest.endsWith("package.json"))) {
      const pkg = await readJsonFile<PackageJson>(join(localPath, manifest));
      const manager = await detectNodeManagerForManifest(localPath, manifest, pkg);
      const packageDir = dirname(manifest);
      commands.push({ name: "install", command: formatNodeCommand(manager, packageDir, ["install"]), source: manifest, purpose: "install" });
      for (const [name, script] of Object.entries(pkg.scripts ?? {})) {
        commands.push({
          name,
          command: formatNodeCommand(manager, packageDir, ["run", name]),
          source: manifest,
          purpose: classifyScript(name, script)
        });
      }
    }
    for (const manifest of manifests.filter((manifest) => manifest.endsWith("requirements.txt"))) {
      commands.push({ name: "install", command: `python3 -m pip install -r ${manifest}`, source: manifest, purpose: "install" });
    }
    for (const manifest of manifests.filter((manifest) => manifest.endsWith("pyproject.toml"))) {
      const projectDir = dirname(manifest);
      commands.push({ name: "install", command: `python3 -m pip install -e ${projectDir === "." ? "." : projectDir}`, source: manifest, purpose: "install" });
    }
    for (const manifest of manifests.filter((manifest) => manifest.endsWith("go.mod"))) {
      const projectDir = dirname(manifest);
      commands.push({ name: "test", command: formatDirectoryCommand(projectDir, "go test ./..."), source: manifest, purpose: "test" });
      commands.push({ name: "build", command: formatDirectoryCommand(projectDir, "go build ./..."), source: manifest, purpose: "build" });
    }
    for (const manifest of manifests.filter((manifest) => manifest.endsWith("Cargo.toml"))) {
      const projectDir = dirname(manifest);
      commands.push({ name: "test", command: formatDirectoryCommand(projectDir, "cargo test"), source: manifest, purpose: "test" });
      commands.push({ name: "build", command: formatDirectoryCommand(projectDir, "cargo build"), source: manifest, purpose: "build" });
    }
    return commands;
  }

  private async detectModules(localPath: string): Promise<RepoModule[]> {
    const roots = ["src", "app", "apps", "packages", "lib", "server", "client", "components", "pages", "tests", "docs"];
    const modules: RepoModule[] = [];
    for (const root of roots) {
      const path = join(localPath, root);
      if (!(await pathExists(path))) continue;
      const entries = await safeReadDir(path);
      modules.push({
        path: relative(localPath, path),
        kind: root === "tests" ? "test" : root === "docs" ? "docs" : "source",
        summary: entries.slice(0, 12).join(", ")
      });
      for (const entry of entries.slice(0, 20)) {
        const child = join(path, entry);
        const childEntries = await safeReadDir(child);
        if (childEntries.length > 0) {
          modules.push({
            path: relative(localPath, child),
            kind: root === "tests" ? "test" : "source",
            summary: childEntries.slice(0, 10).join(", ")
          });
        }
      }
    }
    return modules.slice(0, 80);
  }

  private matchCapabilities(
    capabilities: Capability[],
    readme: string,
    modules: RepoModule[],
    manifests: string[],
    candidate: RepoCandidate
  ): RepoCapabilityMatch[] {
    const haystack = `${candidate.fullName} ${candidate.description} ${readme} ${modules
      .map((module) => `${module.path} ${module.summary}`)
      .join(" ")} ${manifests.join(" ")}`.toLowerCase();

    return capabilities
      .map((capability) => {
        const evidence: string[] = [];
        let hits = 0;
        for (const keyword of [capability.name, ...capability.keywords]) {
          const normalized = keyword.toLowerCase();
          if (normalized.length < 2) continue;
          if (haystack.includes(normalized)) {
            hits += 1;
            evidence.push(keyword);
          }
        }
        const confidence = Math.min(1, hits / Math.max(2, Math.min(6, capability.keywords.length + 1)));
        return {
          capabilityId: capability.id,
          capabilityName: capability.name,
          confidence,
          evidence: [...new Set(evidence)].slice(0, 8)
        };
      })
      .filter((match) => match.confidence > 0);
  }

  private detectRisks(manifests: string[], commands: RepoCommand[], readme: string): string[] {
    const risks: string[] = [];
    if (manifests.length === 0) risks.push("No recognized dependency manifest found.");
    if (!commands.some((command) => command.purpose === "test")) risks.push("No test command detected.");
    if (!commands.some((command) => command.purpose === "build")) risks.push("No build command detected.");
    if (!readme.trim()) risks.push("No README detected.");
    return risks;
  }
}

function classifyScript(name: string, script: string): RepoCommand["purpose"] {
  const text = `${name} ${script}`.toLowerCase();
  if (name === "build" || /\bbuild\b/.test(text)) return "build";
  if (name === "test" || /\btest|vitest|jest|pytest|playwright\b/.test(text)) return "test";
  if (name === "lint" || /\blint|eslint|ruff\b/.test(text)) return "lint";
  if (name === "start") return "start";
  if (name === "dev" || /\bdev\b/.test(text)) return "dev";
  return "other";
}

async function detectNodeManagerForManifest(localPath: string, manifest: string, pkg: PackageJson): Promise<string> {
  if (pkg.packageManager) return pkg.packageManager.split("@")[0] ?? "npm";
  const packageDir = dirname(manifest);
  if (await pathExists(join(localPath, packageDir, "pnpm-lock.yaml"))) return "pnpm";
  if (await pathExists(join(localPath, packageDir, "yarn.lock"))) return "yarn";
  if (await pathExists(join(localPath, packageDir, "package-lock.json"))) return "npm";
  if (packageDir !== "." && await pathExists(join(localPath, "pnpm-lock.yaml"))) return "pnpm";
  if (packageDir !== "." && await pathExists(join(localPath, "yarn.lock"))) return "yarn";
  return "npm";
}

function formatNodeCommand(manager: string, packageDir: string, args: string[]): string {
  const suffix = args.join(" ");
  if (packageDir === ".") return `${manager} ${suffix}`;
  if (manager === "pnpm") return `pnpm --dir ${packageDir} ${suffix}`;
  if (manager === "yarn") return `yarn --cwd ${packageDir} ${suffix}`;
  return `npm --prefix ${packageDir} ${suffix}`;
}

function formatDirectoryCommand(projectDir: string, command: string): string {
  return projectDir === "." ? command : `cd ${projectDir} && ${command}`;
}

function summarize(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/[#*_>`[\]()]/g, " ")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 8)
    .join(" ")
    .slice(0, 1_500);
}

async function safeReadDir(path: string): Promise<string[]> {
  try {
    return (await safeReadDirEntries(path))
      .filter((entry) => !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

async function safeReadDirEntries(path: string): Promise<import("node:fs").Dirent[]> {
  try {
    return (await readdir(path, { withFileTypes: true })).filter((entry) => !entry.name.startsWith("."));
  } catch {
    return [];
  }
}
