import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RepoAnalyzer } from "./repo-analyzer";
import type { Capability, RepoCandidate } from "./types";

const candidate: RepoCandidate = {
  id: 1,
  fullName: "example/polyglot",
  owner: "example",
  name: "polyglot",
  htmlUrl: "https://github.com/example/polyglot",
  cloneUrl: "https://github.com/example/polyglot.git",
  defaultBranch: "main",
  description: "Polyglot dashboard API monorepo",
  stars: 20,
  forks: 2,
  openIssues: 1,
  sizeKb: 512,
  language: "TypeScript",
  license: "MIT",
  updatedAt: "2026-01-01T00:00:00Z",
  pushedAt: "2026-01-01T00:00:00Z",
  archived: false,
  fork: false,
  score: 10,
  matchedCapabilities: []
};

const capabilities: Capability[] = [
  {
    id: "dashboard",
    name: "dashboard",
    description: "dashboard UI",
    keywords: ["dashboard", "react"],
    required: true
  },
  {
    id: "api",
    name: "api",
    description: "API backend",
    keywords: ["api", "python"],
    required: true
  }
];

describe("RepoAnalyzer", () => {
  it("detects nested manifests and commands in real monorepo layouts", async () => {
    const root = join(tmpdir(), `kakashi-analyzer-${randomUUID()}`);
    await mkdir(join(root, "apps", "web", "src"), { recursive: true });
    await mkdir(join(root, "services", "api"), { recursive: true });
    await writeFile(join(root, "README.md"), "React dashboard with a Python API backend.\n", "utf8");
    await writeFile(
      join(root, "apps", "web", "package.json"),
      JSON.stringify({
        packageManager: "pnpm@10.33.0",
        scripts: {
          build: "vite build",
          test: "vitest run"
        },
        dependencies: {
          react: "^19.0.0",
          vite: "^7.0.0",
          typescript: "^5.0.0"
        }
      }),
      "utf8"
    );
    await writeFile(join(root, "services", "api", "pyproject.toml"), "[project]\nname='api'\nversion='0.1.0'\n", "utf8");

    const analysis = await new RepoAnalyzer().analyze(candidate, root, capabilities);

    expect(analysis.manifests).toEqual(["apps/web/package.json", "services/api/pyproject.toml"]);
    expect(analysis.stack).toEqual(expect.arrayContaining(["node", "react", "typescript", "vite", "python"]));
    expect(analysis.packageManagers).toEqual(expect.arrayContaining(["pnpm", "python"]));
    expect(analysis.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: "pnpm --dir apps/web install",
          source: "apps/web/package.json",
          purpose: "install"
        }),
        expect.objectContaining({
          command: "pnpm --dir apps/web run build",
          source: "apps/web/package.json",
          purpose: "build"
        }),
        expect.objectContaining({
          command: "python3 -m pip install -e services/api",
          source: "services/api/pyproject.toml",
          purpose: "install"
        })
      ])
    );
    expect(analysis.capabilityMatches.map((match) => match.capabilityId)).toEqual(expect.arrayContaining(["dashboard", "api"]));
    expect(analysis.risks).not.toContain("No recognized dependency manifest found.");
  });

  it("analyzes root manifests across ecosystems and skips generated directories", async () => {
    const root = join(tmpdir(), `kakashi-analyzer-${randomUUID()}`);
    await mkdir(join(root, "node_modules", "ignored"), { recursive: true });
    await mkdir(join(root, "dist", "ignored"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        scripts: {
          build: "vite build",
          test: "vitest run",
          lint: "eslint .",
          start: "node server.js",
          dev: "vite --host 127.0.0.1",
          release: "node scripts/release.js"
        },
        dependencies: {
          electron: "^39.0.0",
          express: "^5.0.0",
          next: "^16.0.0",
          svelte: "^5.0.0",
          vue: "^3.0.0"
        }
      }),
      "utf8"
    );
    await writeFile(join(root, "yarn.lock"), "# yarn\n", "utf8");
    await writeFile(join(root, "requirements.txt"), "pytest\n", "utf8");
    await writeFile(join(root, "pyproject.toml"), "[project]\nname='root'\nversion='0.1.0'\n", "utf8");
    await writeFile(join(root, "go.mod"), "module example.com/root\n", "utf8");
    await writeFile(join(root, "Cargo.toml"), "[package]\nname='root'\nversion='0.1.0'\nedition='2021'\n", "utf8");
    await writeFile(join(root, "Dockerfile"), "FROM node:24\n", "utf8");
    await writeFile(join(root, "node_modules", "ignored", "package.json"), JSON.stringify({ dependencies: { react: "^19.0.0" } }), "utf8");
    await writeFile(join(root, "dist", "ignored", "pyproject.toml"), "[project]\nname='ignored'\nversion='0.1.0'\n", "utf8");

    const analysis = await new RepoAnalyzer().analyze({ ...candidate, language: null }, root, capabilities);

    expect(analysis.manifests).toEqual(["Cargo.toml", "Dockerfile", "go.mod", "package.json", "pyproject.toml", "requirements.txt", "yarn.lock"]);
    expect(analysis.manifests).not.toContain("node_modules/ignored/package.json");
    expect(analysis.manifests).not.toContain("dist/ignored/pyproject.toml");
    expect(analysis.stack).toEqual(expect.arrayContaining(["node", "nextjs", "vue", "svelte", "express", "electron", "python", "go", "rust", "docker"]));
    expect(analysis.packageManagers).toEqual(expect.arrayContaining(["yarn", "python", "pip", "go", "cargo"]));
    expect(analysis.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: "yarn install", source: "package.json", purpose: "install" }),
        expect.objectContaining({ command: "yarn run lint", source: "package.json", purpose: "lint" }),
        expect.objectContaining({ command: "yarn run start", source: "package.json", purpose: "start" }),
        expect.objectContaining({ command: "yarn run dev", source: "package.json", purpose: "dev" }),
        expect.objectContaining({ command: "yarn run release", source: "package.json", purpose: "other" }),
        expect.objectContaining({ command: "python3 -m pip install -r requirements.txt", source: "requirements.txt", purpose: "install" }),
        expect.objectContaining({ command: "python3 -m pip install -e .", source: "pyproject.toml", purpose: "install" }),
        expect.objectContaining({ command: "go test ./...", source: "go.mod", purpose: "test" }),
        expect.objectContaining({ command: "cargo build", source: "Cargo.toml", purpose: "build" })
      ])
    );
  });

  it("formats nested package manager and compiled-language commands with their source directories", async () => {
    const root = join(tmpdir(), `kakashi-analyzer-${randomUUID()}`);
    await mkdir(join(root, "packages", "shared"), { recursive: true });
    await mkdir(join(root, "apps", "npm-web"), { recursive: true });
    await mkdir(join(root, "apps", "yarn-web"), { recursive: true });
    await mkdir(join(root, "services", "worker"), { recursive: true });
    await mkdir(join(root, "crates", "tool"), { recursive: true });
    await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    await writeFile(join(root, "packages", "shared", "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }), "utf8");
    await writeFile(join(root, "apps", "npm-web", "package.json"), JSON.stringify({ scripts: { build: "vite build" } }), "utf8");
    await writeFile(join(root, "apps", "npm-web", "package-lock.json"), "{}", "utf8");
    await writeFile(join(root, "apps", "yarn-web", "package.json"), JSON.stringify({ scripts: { build: "vite build" } }), "utf8");
    await writeFile(join(root, "apps", "yarn-web", "yarn.lock"), "# yarn\n", "utf8");
    await writeFile(join(root, "services", "worker", "go.mod"), "module example.com/worker\n", "utf8");
    await writeFile(join(root, "crates", "tool", "Cargo.toml"), "[package]\nname='tool'\nversion='0.1.0'\nedition='2021'\n", "utf8");

    const analysis = await new RepoAnalyzer().analyze(candidate, root, []);

    expect(analysis.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: "pnpm --dir packages/shared install", source: "packages/shared/package.json" }),
        expect.objectContaining({ command: "pnpm --dir packages/shared run test", source: "packages/shared/package.json" }),
        expect.objectContaining({ command: "npm --prefix apps/npm-web install", source: "apps/npm-web/package.json" }),
        expect.objectContaining({ command: "npm --prefix apps/npm-web run build", source: "apps/npm-web/package.json" }),
        expect.objectContaining({ command: "yarn --cwd apps/yarn-web install", source: "apps/yarn-web/package.json" }),
        expect.objectContaining({ command: "yarn --cwd apps/yarn-web run build", source: "apps/yarn-web/package.json" }),
        expect.objectContaining({ command: "cd services/worker && go build ./...", source: "services/worker/go.mod" }),
        expect.objectContaining({ command: "cd crates/tool && cargo test", source: "crates/tool/Cargo.toml" })
      ])
    );
  });
});
