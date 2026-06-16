import { readFile } from "node:fs/promises";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { dirname, join } from "node:path";
import type { VerificationResult, VerificationStep } from "./types";
import { pathExists, readJsonFile } from "./utils/fs";
import { runCommand } from "./utils/command";
import { discoverManifests } from "./utils/manifest-discovery";

interface PackageJson {
  name?: string;
  bin?: string | Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  packageManager?: string;
}

const SERVER_READY_PATTERN = /localhost|127\.0\.0\.1|0\.0\.0\.0|listening|ready|started|compiled|running/i;
const READINESS_TIMEOUT_MS = 30_000;

export class Verifier {
  async detect(projectDir: string): Promise<VerificationStep[]> {
    const manifests = await discoverManifests(projectDir);
    const steps: VerificationStep[] = [];
    for (const manifest of manifests.filter((manifest) => manifest.endsWith("package.json"))) {
      steps.push(...await this.detectNode(projectDir, manifest));
    }

    for (const packageDir of pythonProjectDirs(manifests)) {
      steps.push(...await this.detectPython(projectDir, packageDir));
    }

    for (const manifest of manifests.filter((manifest) => manifest.endsWith("go.mod"))) {
      const packageDir = dirname(manifest);
      steps.push(
        scopedStep(packageDir, "go test", ["go", "test", "./..."]),
        scopedStep(packageDir, "go build", ["go", "build", "./..."])
      );
    }

    for (const manifest of manifests.filter((manifest) => manifest.endsWith("Cargo.toml"))) {
      const packageDir = dirname(manifest);
      steps.push(
        scopedStep(packageDir, "cargo test", ["cargo", "test"]),
        scopedStep(packageDir, "cargo build", ["cargo", "build"])
      );
    }
    return steps;
  }

  async verify(projectDir: string, timeoutMs: number, signal?: AbortSignal): Promise<VerificationResult> {
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
        cwd: join(projectDir, step.cwd ?? "."),
        timeoutMs: step.mode === "readiness" ? Math.min(timeoutMs, READINESS_TIMEOUT_MS) : step.name.includes("install") ? Math.max(timeoutMs, 600_000) : timeoutMs,
        signal,
        readyPattern: step.mode === "readiness" ? SERVER_READY_PATTERN : undefined,
        readyCheck: step.mode === "readiness" ? verifyLocalHttpReadiness : undefined
      });
      const ok = this.isStepOk(step, result);
      results.push({
        name: step.name,
        command: result.command,
        ok,
        result
      });
      if (!ok && step.required) break;
      if (signal?.aborted) break;
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

  private async detectNode(projectDir: string, manifest: string): Promise<VerificationStep[]> {
    const packageDir = dirname(manifest);
    const pkg = await readJsonFile<PackageJson>(join(projectDir, manifest));
    const manager = await detectNodeManager(projectDir, packageDir, pkg);
    const scripts = pkg.scripts ?? {};
    const steps: VerificationStep[] = [scopedStep(packageDir, `${manager} install`, [manager, "install"])];

    for (const script of ["lint", "build", "test"]) {
      if (isMeaningfulScript(scripts[script])) {
        steps.push(scopedStep(packageDir, `${manager} ${script}`, [manager, "run", script]));
      }
    }

    const binCommand = firstBinCommand(pkg);
    if (binCommand) {
      steps.push(scopedStep(packageDir, `${binCommand.name} CLI help`, ["node", binCommand.path, "--help"]));
      return steps;
    }

    const runScript = selectRunnableServerScript(scripts, pkg);
    if (runScript) {
      steps.push({
        name: scopedName(packageDir, `${manager} ${runScript} readiness`),
        command: [manager, "run", runScript],
        required: true,
        ...scopedCwd(packageDir),
        mode: "readiness"
      });
    }

    return steps;
  }

  private async detectPython(projectDir: string, packageDir: string): Promise<VerificationStep[]> {
    const pythonDir = join(projectDir, packageDir);
    const steps: VerificationStep[] = [];
    if (await pathExists(join(pythonDir, "requirements.txt"))) {
      steps.push(scopedStep(packageDir, "pip install requirements", ["python3", "-m", "pip", "install", "-r", "requirements.txt"]));
    } else {
      steps.push(scopedStep(packageDir, "pip install editable", ["python3", "-m", "pip", "install", "-e", "."]));
    }

    if (await containsFile(pythonDir, "pytest.ini") || (await pathExists(join(pythonDir, "tests")))) {
      steps.push(scopedStep(packageDir, "pytest", ["python3", "-m", "pytest"]));
    }
    return steps;
  }

  private isStepOk(step: VerificationStep, result: { exitCode: number | null; ready?: boolean }): boolean {
    if (step.mode === "readiness") {
      return result.exitCode === 0 && result.ready === true;
    }
    return result.exitCode === 0;
  }
}

async function verifyLocalHttpReadiness(output: string): Promise<boolean> {
  const urls = extractLocalReadinessUrls(output);
  if (urls.length === 0) return true;
  for (const url of urls) {
    if (await isHealthyHttpUrl(url)) return true;
  }
  return false;
}

function extractLocalReadinessUrls(output: string): URL[] {
  const cleanOutput = stripAnsi(output);
  const matches = cleanOutput.match(/https?:\/\/[^\s'"<>]+/gi) ?? [];
  const urls: URL[] = [];
  for (const match of matches) {
    try {
      const url = new URL(match.replace(/[),.;]+$/, ""));
      if (!isLocalHost(url.hostname)) continue;
      if (url.hostname === "0.0.0.0" || url.hostname === "::") url.hostname = "127.0.0.1";
      urls.push(url);
    } catch {
      // Ignore non-URL fragments in command output.
    }
  }
  return urls;
}

function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "0.0.0.0" || host === "::" || host === "::1" || host === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function isHealthyHttpUrl(url: URL): Promise<boolean> {
  return new Promise((resolveHealth) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolveHealth(ok);
    };
    const get = url.protocol === "https:" ? httpsGet : httpGet;
    const request = get(url, { timeout: 1_000 }, (response) => {
      response.resume();
      response.on("end", () => {
        const statusCode = response.statusCode ?? 0;
        finish(statusCode >= 200 && statusCode < 400);
      });
    });
    request.on("timeout", () => {
      request.destroy();
      finish(false);
    });
    request.on("error", () => finish(false));
  });
}

function stripAnsi(value: string): string {
  let clean = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 27 || value[index + 1] !== "[") {
      clean += value[index] ?? "";
      continue;
    }
    index += 2;
    while (index < value.length && !isAnsiFinalByte(value.charCodeAt(index))) {
      index += 1;
    }
  }
  return clean;
}

function isAnsiFinalByte(code: number): boolean {
  return code >= 0x40 && code <= 0x7e;
}

async function detectNodeManager(projectDir: string, packageDir: string, pkg: PackageJson): Promise<string> {
  if (pkg.packageManager) return pkg.packageManager.split("@")[0] ?? "npm";
  if (await pathExists(join(projectDir, packageDir, "pnpm-lock.yaml"))) return "pnpm";
  if (await pathExists(join(projectDir, packageDir, "yarn.lock"))) return "yarn";
  if (packageDir !== "." && await pathExists(join(projectDir, "pnpm-lock.yaml"))) return "pnpm";
  if (packageDir !== "." && await pathExists(join(projectDir, "yarn.lock"))) return "yarn";
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

function pythonProjectDirs(manifests: string[]): string[] {
  const dirs = new Set<string>();
  for (const manifest of manifests) {
    if (manifest.endsWith("pyproject.toml") || manifest.endsWith("requirements.txt")) {
      dirs.add(dirname(manifest));
    }
  }
  return [...dirs];
}

function scopedStep(packageDir: string, label: string, command: string[]): VerificationStep {
  return {
    name: scopedName(packageDir, label),
    command,
    required: true,
    ...scopedCwd(packageDir)
  };
}

function scopedName(packageDir: string, label: string): string {
  return packageDir === "." ? label : `${packageDir} ${label}`;
}

function scopedCwd(packageDir: string): Pick<VerificationStep, "cwd"> {
  return packageDir === "." ? {} : { cwd: packageDir };
}
