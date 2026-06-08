import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { VerificationResult, VerificationStep } from "./types";
import { pathExists, readJsonFile } from "./utils/fs";
import { runCommand } from "./utils/command";

interface PackageJson {
  name?: string;
  bin?: string | Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  packageManager?: string;
}

const SERVER_READY_PATTERN = /localhost|127\.0\.0\.1|0\.0\.0\.0|listening|ready|started|compiled|running|server/i;
const READINESS_TIMEOUT_MS = 30_000;

export class Verifier {
  async detect(projectDir: string): Promise<VerificationStep[]> {
    if (await pathExists(join(projectDir, "package.json"))) {
      return await this.detectNode(projectDir);
    }
    if (await pathExists(join(projectDir, "pyproject.toml")) || await pathExists(join(projectDir, "requirements.txt"))) {
      return await this.detectPython(projectDir);
    }
    if (await pathExists(join(projectDir, "go.mod"))) {
      return [
        { name: "go test", command: ["go", "test", "./..."], required: true },
        { name: "go build", command: ["go", "build", "./..."], required: true }
      ];
    }
    if (await pathExists(join(projectDir, "Cargo.toml"))) {
      return [
        { name: "cargo test", command: ["cargo", "test"], required: true },
        { name: "cargo build", command: ["cargo", "build"], required: true }
      ];
    }
    return [];
  }

  async verify(projectDir: string, timeoutMs: number): Promise<VerificationResult> {
    const steps = await this.detect(projectDir);
    if (steps.length === 0) {
      return {
        ok: false,
        steps: [],
        summary: "No supported project manifest was found, so Kakashi could not verify install/build/test commands."
      };
    }

    const results: VerificationResult["steps"] = [];
    for (const step of steps) {
      const result = await runCommand(step.command[0]!, step.command.slice(1), {
        cwd: projectDir,
        timeoutMs: step.mode === "readiness" ? Math.min(timeoutMs, READINESS_TIMEOUT_MS) : step.name.includes("install") ? Math.max(timeoutMs, 600_000) : timeoutMs,
        readyPattern: step.mode === "readiness" ? SERVER_READY_PATTERN : undefined
      });
      const ok = this.isStepOk(step, result);
      results.push({
        name: step.name,
        command: result.command,
        ok,
        result
      });
      if (!ok && step.required) break;
    }

    const failedRequired = results.find((step) => !step.ok && steps.find((candidate) => candidate.name === step.name)?.required);
    return {
      ok: !failedRequired,
      steps: results,
      summary: failedRequired
        ? `Verification failed at ${failedRequired.name}.`
        : `Verification passed ${results.length} detected step(s).`
    };
  }

  private async detectNode(projectDir: string): Promise<VerificationStep[]> {
    const pkg = await readJsonFile<PackageJson>(join(projectDir, "package.json"));
    const manager = await detectNodeManager(projectDir, pkg);
    const scripts = pkg.scripts ?? {};
    const steps: VerificationStep[] = [{ name: `${manager} install`, command: [manager, "install"], required: true }];

    for (const script of ["lint", "build", "test"]) {
      if (isMeaningfulScript(scripts[script])) {
        steps.push({ name: `${manager} ${script}`, command: [manager, "run", script], required: true });
      }
    }

    const binCommand = firstBinCommand(pkg);
    if (binCommand) {
      steps.push({ name: `${binCommand.name} CLI help`, command: ["node", binCommand.path, "--help"], required: true });
      return steps;
    }

    const runScript = selectRunnableServerScript(scripts, pkg);
    if (runScript) {
      steps.push({
        name: `${manager} ${runScript} readiness`,
        command: [manager, "run", runScript],
        required: true,
        mode: "readiness"
      });
    }

    return steps;
  }

  private async detectPython(projectDir: string): Promise<VerificationStep[]> {
    const steps: VerificationStep[] = [];
    if (await pathExists(join(projectDir, "requirements.txt"))) {
      steps.push({
        name: "pip install requirements",
        command: ["python3", "-m", "pip", "install", "-r", "requirements.txt"],
        required: true
      });
    } else {
      steps.push({ name: "pip install editable", command: ["python3", "-m", "pip", "install", "-e", "."], required: true });
    }

    if (await containsFile(projectDir, "pytest.ini") || (await pathExists(join(projectDir, "tests")))) {
      steps.push({ name: "pytest", command: ["python3", "-m", "pytest"], required: true });
    }
    return steps;
  }

  private isStepOk(step: VerificationStep, result: { exitCode: number | null; timedOut: boolean; stdout: string; stderr: string }): boolean {
    if (step.mode === "readiness") {
      return result.exitCode === 0 && SERVER_READY_PATTERN.test(`${result.stdout}\n${result.stderr}`);
    }
    return result.exitCode === 0;
  }
}

async function detectNodeManager(projectDir: string, pkg: PackageJson): Promise<string> {
  if (pkg.packageManager) return pkg.packageManager.split("@")[0] ?? "npm";
  if (await pathExists(join(projectDir, "pnpm-lock.yaml"))) return "pnpm";
  if (await pathExists(join(projectDir, "yarn.lock"))) return "yarn";
  return "npm";
}

function isMeaningfulScript(script: string | undefined): boolean {
  if (!script) return false;
  return !/no test specified|echo\s+["']?error|exit\s+1/i.test(script);
}

function firstBinCommand(pkg: PackageJson): { name: string; path: string } | null {
  if (typeof pkg.bin === "string") {
    return { name: pkg.name ?? "package", path: pkg.bin };
  }
  if (!pkg.bin) return null;
  const [name, path] = Object.entries(pkg.bin)[0] ?? [];
  return name && path ? { name, path } : null;
}

function selectRunnableServerScript(scripts: Record<string, string>, pkg: PackageJson): "start" | "dev" | null {
  if (isMeaningfulScript(scripts.start) && isServerScript(scripts.start, pkg)) return "start";
  if (isMeaningfulScript(scripts.dev) && isServerScript(scripts.dev, pkg)) return "dev";
  return null;
}

function isServerScript(script: string | undefined, pkg: PackageJson): boolean {
  if (!script) return false;
  const text = script.toLowerCase();
  if (/\b(--watch|watch)\b|tsup|rollup|tsc\s+-w|vite\s+build|webpack\s+--watch/.test(text)) return false;
  if (/\b(vite|next\s+(dev|start)|nuxt|astro\s+dev|remix-serve|webpack\s+serve|react-scripts\s+start)\b/.test(text)) {
    return true;
  }
  if (/\b(node|tsx|ts-node)\b.*\b(server|app)\b/.test(text) && hasServerDependency(pkg)) return true;
  return /\bserve\b/.test(text) && hasServerDependency(pkg);
}

function hasServerDependency(pkg: PackageJson): boolean {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  return [
    "express",
    "fastify",
    "koa",
    "hono",
    "@hono/node-server",
    "vite",
    "next",
    "nuxt",
    "astro",
    "@remix-run/serve",
    "react-scripts"
  ].some((name) => Boolean(deps[name]));
}

async function containsFile(projectDir: string, name: string): Promise<boolean> {
  try {
    await readFile(join(projectDir, name), "utf8");
    return true;
  } catch {
    return false;
  }
}
