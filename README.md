# Kakashi

Kakashi 是一个基于 Codex CLI / Codex Desktop 的开源能力融合系统。用户用一句话描述想做的软件，Kakashi 会搜索真实 GitHub 仓库，分析仓库能力，生成融合方案，调用 Codex CLI 改造代码，执行真实验证，并输出来源追踪和验证报告。

English: Kakashi is a Codex-powered open-source capability fusion system. A user describes the software they want, Kakashi searches real GitHub repositories, analyzes repository capabilities, plans a fusion strategy, asks Codex CLI to modify code, verifies the generated project, and exports provenance plus verification reports.

Kakashi 不直接 fork Codex CLI。它把 Codex CLI 作为代码执行引擎，把 GitHub 作为开源能力来源。

English: Kakashi does not fork Codex CLI. It treats Codex CLI as the code execution engine and GitHub as the source of open-source capabilities.

## 能力范围 / What It Builds

- 将用户需求解析为目标、技术栈、约束和能力节点。 / Parses requirements into target, stack, constraints, and capability nodes.
- 通过 Octokit 与 `gh`/token 认证执行真实 GitHub 仓库搜索。 / Searches real GitHub repositories through Octokit and `gh`/token authentication.
- 克隆真实仓库，并分析 manifest、命令、技术栈、模块、README 证据和许可证信息。 / Clones real repositories and analyzes manifests, commands, stack, modules, README evidence, and license metadata.
- 构建能力图谱，并选择主项目和辅助项目。 / Builds a capability graph and selects main and auxiliary repositories.
- 通过生成项目中的 `codex exec` 执行真实 Codex CLI 改造。 / Executes Codex CLI through `codex exec` in the generated project.
- 基于实际项目文件检测并运行 install/build/test/lint/start 验证命令。 / Verifies install/build/test/lint/start commands detected from actual project files.
- 根据真实 verifier 日志检测缺失能力，并继续执行 GitHub 搜索。 / Detects gaps from real verifier logs and performs follow-up GitHub searches.
- 提供 CLI 与本地 Web UI，支持全自动模式和交互式模式。 / Provides a CLI and local Web UI for full-auto and interactive runs.
- 输出完整流程文档 `KAKASHI_REPORT.md`，以及 `SOURCE_PROVENANCE.json`、`.kakashi/run-report.json` 和源仓库许可证副本。 / Exports full process documentation in `KAKASHI_REPORT.md`, plus `SOURCE_PROVENANCE.json`, `.kakashi/run-report.json`, and copied source license files.

## 环境要求 / Requirements

单文件可执行版本需要：

English: The single-file executable requires:

- Git
- 已认证的 GitHub CLI：`gh auth login`，或 `GITHUB_TOKEN` / `GH_TOKEN`。 / GitHub CLI authenticated with `gh auth login`, or `GITHUB_TOKEN` / `GH_TOKEN`.
- 可用的 Codex CLI：命令名为 `codex`。 / Codex CLI available as `codex`.

单文件可执行版本已经内置启动 Kakashi 所需的 Node.js runtime。生成项目在验证时仍可能需要该项目自己的语言运行时和包管理器。

English: The single-file executable bundles the Node.js runtime needed to start Kakashi. Generated projects may still need their own language runtimes and package managers during verification.

归档包或源码开发还需要：

English: Release archives or source development also require:

- Node.js 24+
- Git
- 已认证的 GitHub CLI：`gh auth login`，或 `GITHUB_TOKEN` / `GH_TOKEN`。 / GitHub CLI authenticated with `gh auth login`, or `GITHUB_TOKEN` / `GH_TOKEN`.
- 可用的 Codex CLI：命令名为 `codex`。 / Codex CLI available as `codex`.
- 源码开发需要 pnpm 10+。 / pnpm 10+ when developing from source.

## 从 GitHub Release 安装 / Install From GitHub Release

优先下载与你系统匹配的单文件可执行文件：

English: Prefer downloading the single-file executable that matches your system:

- `kakashi-v0.2.0-linux-x64`
- `kakashi-v0.2.0-linux-arm64`
- `kakashi-v0.2.0-darwin-x64`
- `kakashi-v0.2.0-darwin-arm64`
- `kakashi-v0.2.0-windows-x64.exe`
- `kakashi-v0.2.0-windows-arm64.exe`

使用 Release 中的 `SHA256SUMS.txt` 校验下载文件。

English: Verify downloads with the release `SHA256SUMS.txt` file.

Linux/macOS:

```bash
chmod +x kakashi-v0.2.0-darwin-arm64
./kakashi-v0.2.0-darwin-arm64 doctor
./kakashi-v0.2.0-darwin-arm64 run "Build a TypeScript CLI with tests" --out ./generated --max-repos 8 --max-iterations 2 --force
```

Windows PowerShell:

```powershell
.\kakashi-v0.2.0-windows-x64.exe doctor
.\kakashi-v0.2.0-windows-x64.exe run "Build a TypeScript CLI with tests" --out .\generated --max-repos 8 --max-iterations 2 --force
```

单文件可执行版本内嵌 Web UI，启动方式：

English: The single-file executable embeds the Web UI. Start it with:

```bash
./kakashi-v0.2.0-darwin-arm64 serve --port 4317
```

打开 `http://127.0.0.1:4317/`。

English: Open `http://127.0.0.1:4317/`.

Release 也包含完整归档包，适合需要 `README.md`、`INSTALL.md`、`LICENSE`、wrapper scripts 和 Web UI 文件目录的用户：

English: Release also includes full archive packages for users who prefer a directory with `README.md`, `INSTALL.md`, `LICENSE`, wrapper scripts, and Web UI files:

- `kakashi-v0.2.0-linux-x64.tar.gz`
- `kakashi-v0.2.0-linux-arm64.tar.gz`
- `kakashi-v0.2.0-darwin-x64.tar.gz`
- `kakashi-v0.2.0-darwin-arm64.tar.gz`
- `kakashi-v0.2.0-windows-x64.tar.gz`
- `kakashi-v0.2.0-windows-arm64.tar.gz`

归档包包含 Node-based Kakashi CLI bundle、构建后的 Web UI 和 `INSTALL.md`。归档包运行时仍需要 Node.js 24+、Git、GitHub CLI 认证和 Codex CLI。

English: Each archive contains a standalone Node-based Kakashi CLI bundle, the built Web UI, and an `INSTALL.md` file. Archives still require Node.js 24+, Git, GitHub CLI authentication, and Codex CLI at runtime.

Linux/macOS:

```bash
tar -xzf kakashi-v0.2.0-linux-x64.tar.gz
cd kakashi-v0.2.0-linux-x64
./bin/kakashi doctor
./bin/kakashi run "Build a TypeScript CLI with tests" --out ./generated --max-repos 8 --max-iterations 2 --force
```

Windows PowerShell:

```powershell
tar -xzf kakashi-v0.2.0-windows-x64.tar.gz
cd kakashi-v0.2.0-windows-x64
.\bin\kakashi.cmd doctor
.\bin\kakashi.cmd run "Build a TypeScript CLI with tests" --out .\generated --max-repos 8 --max-iterations 2 --force
```

使用归档包内置 Web UI：

English: To use the bundled Web UI from a release archive:

```bash
./bin/kakashi serve --web-dir ./web --port 4317
```

打开 `http://127.0.0.1:4317/`。

English: Open `http://127.0.0.1:4317/`.

## 源码启动 / Source Setup

运行：

English: Run:

```bash
pnpm install
pnpm build
pnpm run doctor
```

## 命令行 / CLI

全自动模式：

English: Full auto mode:

```bash
pnpm kakashi run \
  "Build a TypeScript web dashboard with GitHub search, capability graph, and live Codex execution logs" \
  --out ./generated-dashboard \
  --max-repos 12 \
  --max-iterations 3
```

交互式模式：

English: Interactive mode:

```bash
pnpm kakashi interactive \
  "Build a local-first project management app with Kanban, calendar, and export" \
  --out ./generated-project
```

查看历史运行：

English: Inspect a previous run:

```bash
pnpm kakashi inspect <runId>
```

## 网页版 / Web UI

源码开发时先启动 API server：

English: From source, start the API server:

```bash
pnpm --filter @kakashi/server dev
```

再启动 Vite UI：

English: Start the Vite UI:

```bash
pnpm --filter @kakashi/web dev
```

打开 `http://127.0.0.1:5173`。

English: Open `http://127.0.0.1:5173`.

执行 `pnpm build` 后，可通过 CLI 提供生产风格的本地 Web UI：

English: For a production-style local Web UI after `pnpm build`, serve the built Web app through the CLI:

```bash
pnpm kakashi serve --web-dir apps/web/dist --port 4317
```

打开 `http://127.0.0.1:4317`。

English: Open `http://127.0.0.1:4317`.

## 发布构建 / Release Build

创建本地完整归档包：

English: Create local full archive packages:

```bash
pnpm release:package
```

归档包会写入 `dist/release/`，并生成 `SHA256SUMS.txt`。

English: Release archives are written to `dist/release/` with `SHA256SUMS.txt`.

为当前平台创建本地单文件可执行文件：

English: Create a local single-file executable for the current platform:

```bash
pnpm release:executable
```

创建指定平台的可执行文件：

English: Create a specific executable target:

```bash
pnpm release:executable -- --target=darwin-arm64
```

可执行文件会写入 `dist/executables/`。

English: Executable assets are written to `dist/executables/`.

## 许可证策略 / License Policy

默认情况下，Kakashi 只使用声明为宽松 SPDX 许可证的仓库：MIT、Apache-2.0、BSD、ISC 或 0BSD。传入 `--allow-copyleft` 可包含常见 copyleft 许可证。默认会排除未声明许可证的仓库。

English: By default Kakashi only uses repositories with declared permissive SPDX licenses: MIT, Apache-2.0, BSD, ISC, or 0BSD. Pass `--allow-copyleft` to include common copyleft licenses. Repositories without a declared license are excluded by default.

## 项目许可证 / Project License

Kakashi 使用 MIT License 发布。详见 `LICENSE`。

English: Kakashi is released under the MIT License. See `LICENSE`.

## 验证 / Verification

本地检查：

English: Local checks:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

真实集成检查：

English: Real integration checks:

```bash
RUN_REAL_INTEGRATION=1 pnpm test:integration
RUN_CODEX_INTEGRATION=1 pnpm test:codex
pnpm test:e2e
```

集成检查会使用真实 GitHub/Codex 命令，需要网络访问和有效的本地认证。

English: The integration checks use real GitHub/Codex commands. They require network access and valid local authentication.

## 最终流程报告 / Final Process Report

每次完整运行都会在生成项目中写入 `KAKASHI_REPORT.md`。该报告包含原始需求、解析出的能力、分析过的 GitHub 仓库、每个仓库的用途和技术栈、选中的主项目/辅助项目、能力匹配、提供给 Codex 参考的源码区域、Codex 迭代摘要、验证尝试、修复回环状态和导出的产物。

English: Every completed run writes `KAKASHI_REPORT.md` into the generated project. It includes the original requirement, parsed capabilities, every GitHub repository analyzed, each repository's purpose and detected stack, selected main/auxiliary sources, capability matches, source areas prepared for Codex reference, Codex iteration summaries, verifier attempts, repair-loop status, and exported artifacts.
