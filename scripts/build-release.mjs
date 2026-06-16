#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { chmodSync, existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageJson = JSON.parse(await readFile(join(rootDir, "package.json"), "utf8"));
const rawVersion = process.env.RELEASE_VERSION || packageJson.version;
const version = rawVersion.startsWith("v") ? rawVersion.slice(1) : rawVersion;
const targets = parseTargets(process.argv.slice(2));
const releaseDir = join(rootDir, "dist", "release");
const bundleDir = join(releaseDir, ".bundle");
const bundlePath = join(bundleDir, "kakashi.mjs");

await rm(releaseDir, { recursive: true, force: true });
await mkdir(bundleDir, { recursive: true });

run("pnpm", ["build"]);
run("pnpm", [
  "exec",
  "esbuild",
  "apps/cli/src/index.ts",
  "--bundle",
  "--platform=node",
  "--target=node24",
  "--format=esm",
  `--outfile=${bundlePath}`,
  "--banner:js=import { createRequire } from \"node:module\"; const require = createRequire(import.meta.url);"
]);
chmodSync(bundlePath, 0o755);

const archives = [];
for (const target of targets) {
  const packageName = `kakashi-v${version}-${target}`;
  const packageDir = join(releaseDir, packageName);
  await mkdir(join(packageDir, "bin"), { recursive: true });
  await cp(bundlePath, join(packageDir, "bin", "kakashi.mjs"));
  await writeFile(join(packageDir, "bin", "kakashi"), unixWrapper(), { mode: 0o755 });
  await writeFile(join(packageDir, "bin", "kakashi.cmd"), windowsWrapper(), "utf8");
  await writeFile(join(packageDir, "TARGET"), `${target}\n`, "utf8");
  await writeFile(join(packageDir, "INSTALL.md"), installGuide(version, target), "utf8");
  await cp(join(rootDir, "README.md"), join(packageDir, "README.md"));
  await cp(join(rootDir, "README-en.md"), join(packageDir, "README-en.md"));
  await cp(join(rootDir, "LICENSE"), join(packageDir, "LICENSE"));
  await cp(join(rootDir, "CONTRIBUTING.md"), join(packageDir, "CONTRIBUTING.md"));
  await cp(join(rootDir, "SECURITY.md"), join(packageDir, "SECURITY.md"));

  const webDist = join(rootDir, "apps", "web", "dist");
  if (existsSync(webDist)) {
    await cp(webDist, join(packageDir, "web"), { recursive: true });
  }

  const archive = join(releaseDir, `${packageName}.tar.gz`);
  run("tar", ["-czf", archive, "-C", releaseDir, packageName]);
  archives.push(archive);
}

const checksums = [];
for (const archive of archives) {
  const data = await readFile(archive);
  checksums.push(`${createHash("sha256").update(data).digest("hex")}  ${basename(archive)}`);
}
await writeFile(join(releaseDir, "SHA256SUMS.txt"), `${checksums.join("\n")}\n`, "utf8");

for (const archive of archives) {
  console.log(`built ${archive}`);
}
console.log(`built ${join(releaseDir, "SHA256SUMS.txt")}`);

function parseTargets(args) {
  const targetArg = args.find((arg) => arg.startsWith("--target="));
  if (targetArg) return [targetArg.split("=")[1]].filter(Boolean);
  return ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "windows-x64", "windows-arm64"];
}

function run(command, args) {
  execFileSync(command, args, {
    cwd: rootDir,
    stdio: "inherit",
    env: process.env
  });
}

function unixWrapper() {
  return `#!/usr/bin/env sh
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$SCRIPT_DIR/kakashi.mjs" "$@"
`;
}

function windowsWrapper() {
  return `@echo off\r
set "SCRIPT_DIR=%~dp0"\r
node "%SCRIPT_DIR%kakashi.mjs" %*\r
`;
}

function installGuide(currentVersion, target) {
  return `# Kakashi ${currentVersion} (${target})

语言文档：

- 中文默认文档：README.md
- English documentation: README-en.md

## 环境要求 / Requirements

归档包运行时需要：

English: Release archives require:

- Node.js 24+
- Git
- 已认证的 GitHub CLI：\`gh auth login\`，或 \`GITHUB_TOKEN\` / \`GH_TOKEN\`。 / GitHub CLI authenticated with \`gh auth login\` or \`GITHUB_TOKEN\` / \`GH_TOKEN\`.
- 可用的 Codex CLI：命令名为 \`codex\`。 / Codex CLI available as \`codex\`.

## 配置 / Configuration

Kakashi 本身没有单独的 Kakashi API Key。它需要 GitHub 认证和 Codex 认证。

English: Kakashi does not have a separate Kakashi API key. It needs GitHub authentication and Codex authentication.

配置 GitHub：

English: Configure GitHub:

\`\`\`bash
gh auth login
gh auth status
\`\`\`

无交互环境可以使用环境变量：

English: In non-interactive environments, use an environment variable:

\`\`\`bash
export GH_TOKEN="github_pat_xxx"
# 或 / or
export GITHUB_TOKEN="github_pat_xxx"
\`\`\`

配置 Codex：

English: Configure Codex:

Kakashi doctor 会执行 \`codex login status\`，确认 Codex 已认证，而不只是命令存在。

English: Kakashi doctor runs \`codex login status\` to confirm Codex is authenticated, not merely installed.

\`\`\`bash
codex login
codex login status
\`\`\`

如果使用 OpenAI API Key：

English: If you use an OpenAI API key:

\`\`\`bash
export OPENAI_API_KEY="sk-..."
printenv OPENAI_API_KEY | codex login --with-api-key
codex login status
\`\`\`

不要把 API Key、GitHub token 或 access token 写进代码、README、issue、日志或生成项目。

English: Do not commit API keys, GitHub tokens, or access tokens to source code, README files, issues, logs, or generated projects.

验证配置：

English: Verify configuration:

\`\`\`bash
./bin/kakashi doctor
\`\`\`

## 命令行 / CLI

Linux/macOS:

\`\`\`bash
./bin/kakashi doctor
./bin/kakashi run "Build a TypeScript CLI with tests" --out ./generated --max-repos 8 --max-iterations 2 --force
\`\`\`

Windows PowerShell:

\`\`\`powershell
.\\bin\\kakashi.cmd doctor
.\\bin\\kakashi.cmd run "Build a TypeScript CLI with tests" --out .\\generated --max-repos 8 --max-iterations 2 --force
\`\`\`

## 网页版 / Web UI

启动归档包内置 Web UI：

English: Start the bundled Web UI:

\`\`\`bash
./bin/kakashi serve --web-dir ./web --port 4317
\`\`\`

打开 http://127.0.0.1:4317/.

English: Open http://127.0.0.1:4317/.
`;
}
