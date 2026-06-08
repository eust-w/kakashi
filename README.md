# Kakashi

语言 / Language: 简体中文 | [English](README-en.md)

Kakashi 是一个基于 Codex CLI / Codex Desktop 的开源能力融合系统。用户用一句话描述想做的软件，Kakashi 会搜索真实 GitHub 仓库，分析仓库能力，生成融合方案，调用 Codex CLI 改造代码，执行真实验证，并输出来源追踪和验证报告。

Kakashi 不直接 fork Codex CLI。它把 Codex CLI 作为代码执行引擎，把 GitHub 作为开源能力来源。

## 能力范围

- 将用户需求解析为目标、技术栈、约束和能力节点。
- 通过 Octokit 与 `gh`/token 认证执行真实 GitHub 仓库搜索。
- 克隆真实仓库，并分析 manifest、命令、技术栈、模块、README 证据和许可证信息。
- 构建能力图谱，并选择主项目和辅助项目。
- 通过生成项目中的 `codex exec` 执行真实 Codex CLI 改造。
- 基于实际项目文件检测并运行 install/build/test/lint/start 验证命令。
- 根据真实 verifier 日志检测缺失能力，并继续执行 GitHub 搜索。
- 提供 CLI 与本地 Web UI，支持全自动模式和交互式模式。
- 输出完整流程文档 `KAKASHI_REPORT.md`，以及 `SOURCE_PROVENANCE.json`、`.kakashi/run-report.json` 和源仓库许可证副本。

## 环境要求

单文件可执行版本需要：

- Git
- 已认证的 GitHub CLI：`gh auth login`，或 `GITHUB_TOKEN` / `GH_TOKEN`
- 可用的 Codex CLI：命令名为 `codex`

单文件可执行版本已经内置启动 Kakashi 所需的 Node.js runtime。生成项目在验证时仍可能需要该项目自己的语言运行时和包管理器。

归档包或源码开发还需要：

- Node.js 24+
- Git
- 已认证的 GitHub CLI：`gh auth login`，或 `GITHUB_TOKEN` / `GH_TOKEN`
- 可用的 Codex CLI：命令名为 `codex`
- 源码开发需要 pnpm 10+

## 配置

Kakashi 本身没有单独的 Kakashi API Key。它需要配置两类外部能力：

- GitHub 认证：用于搜索、读取和克隆 GitHub 仓库。
- Codex 认证：用于调用 `codex exec` 改造和修复代码。

### 1. 配置 GitHub

推荐使用 GitHub CLI 登录：

```bash
gh auth login
gh auth status
```

如果你在 CI、服务器或无交互环境中运行，也可以使用环境变量：

```bash
export GH_TOKEN="github_pat_xxx"
# 或
export GITHUB_TOKEN="github_pat_xxx"
```

Kakashi 的读取顺序是：

1. `GITHUB_TOKEN`
2. `GH_TOKEN`
3. `gh auth token`

如果只搜索公开仓库，普通 GitHub CLI 登录通常够用。如果要访问私有仓库，需要确保 token 或 `gh auth login` 登录账号有对应仓库权限。

### 2. 配置 Codex

Kakashi 会调用本机的 `codex exec`，所以需要先让 Codex CLI 能独立运行。

使用浏览器/设备登录：

```bash
codex login
codex login status
```

使用 OpenAI API Key：

```bash
export OPENAI_API_KEY="sk-..."
printenv OPENAI_API_KEY | codex login --with-api-key
codex login status
```

也可以使用 Codex access token：

```bash
export CODEX_ACCESS_TOKEN="..."
printenv CODEX_ACCESS_TOKEN | codex login --with-access-token
codex login status
```

不要把 API Key、GitHub token 或 access token 写进代码、README、issue、日志或生成项目。建议使用系统凭据管理器、CI secrets、shell 会话环境变量，或 `gh auth login` / `codex login` 自己的凭据存储。

### 3. 验证配置

运行：

```bash
kakashi doctor
```

如果使用单文件可执行文件：

```bash
./kakashi-v0.2.0-darwin-arm64 doctor
```

如果从源码运行：

```bash
pnpm kakashi doctor
```

正常情况下应看到：

- `PASS git`
- `PASS gh`
- `PASS codex`
- `PASS github-auth`
- `PASS codex-version`
- `PASS gh-version`
- `PASS git-version`

### 4. 网页版配置

网页版不需要单独的 API Key 配置。它使用启动 Kakashi server 的同一个系统环境和 PATH。

也就是说，先在同一个终端里确认：

```bash
gh auth status
codex login status
kakashi doctor
```

然后再启动 Web UI：

```bash
kakashi serve --port 4317
```

如果通过源码启动前后端，也要在同一个 shell 环境中启动 server：

```bash
pnpm --filter @kakashi/server dev
pnpm --filter @kakashi/web dev
```

### 5. 可选配置

指定 Codex 模型：

```bash
kakashi run "Build a TypeScript CLI with tests" --out ./generated --model <codex-model-name>
```

调整 GitHub 分析数量和修复轮数：

```bash
kakashi run "Build a dashboard" --out ./generated --max-repos 12 --max-iterations 3
```

允许 copyleft 许可证仓库进入候选：

```bash
kakashi run "Build a dashboard" --out ./generated --allow-copyleft
```

## 从 GitHub Release 安装

优先下载与你系统匹配的单文件可执行文件：

- `kakashi-v0.2.0-linux-x64`
- `kakashi-v0.2.0-linux-arm64`
- `kakashi-v0.2.0-darwin-x64`
- `kakashi-v0.2.0-darwin-arm64`
- `kakashi-v0.2.0-windows-x64.exe`
- `kakashi-v0.2.0-windows-arm64.exe`

使用 Release 中的 `SHA256SUMS.txt` 校验下载文件。

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

```bash
./kakashi-v0.2.0-darwin-arm64 serve --port 4317
```

打开 `http://127.0.0.1:4317/`。

Release 也包含完整归档包，适合需要 `README.md`、`README-en.md`、`INSTALL.md`、`LICENSE`、wrapper scripts 和 Web UI 文件目录的用户：

- `kakashi-v0.2.0-linux-x64.tar.gz`
- `kakashi-v0.2.0-linux-arm64.tar.gz`
- `kakashi-v0.2.0-darwin-x64.tar.gz`
- `kakashi-v0.2.0-darwin-arm64.tar.gz`
- `kakashi-v0.2.0-windows-x64.tar.gz`
- `kakashi-v0.2.0-windows-arm64.tar.gz`

归档包包含 Node-based Kakashi CLI bundle、构建后的 Web UI 和 `INSTALL.md`。归档包运行时仍需要 Node.js 24+、Git、GitHub CLI 认证和 Codex CLI。

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

```bash
./bin/kakashi serve --web-dir ./web --port 4317
```

打开 `http://127.0.0.1:4317/`。

## 源码启动

运行：

```bash
pnpm install
pnpm build
pnpm run doctor
```

## 命令行

全自动模式：

```bash
pnpm kakashi run \
  "Build a TypeScript web dashboard with GitHub search, capability graph, and live Codex execution logs" \
  --out ./generated-dashboard \
  --max-repos 12 \
  --max-iterations 3
```

交互式模式：

```bash
pnpm kakashi interactive \
  "Build a local-first project management app with Kanban, calendar, and export" \
  --out ./generated-project
```

查看历史运行：

```bash
pnpm kakashi inspect <runId>
```

## 网页版

源码开发时先启动 API server：

```bash
pnpm --filter @kakashi/server dev
```

再启动 Vite UI：

```bash
pnpm --filter @kakashi/web dev
```

打开 `http://127.0.0.1:5173`。

执行 `pnpm build` 后，可通过 CLI 提供生产风格的本地 Web UI：

```bash
pnpm kakashi serve --web-dir apps/web/dist --port 4317
```

打开 `http://127.0.0.1:4317`。

## 发布构建

创建本地完整归档包：

```bash
pnpm release:package
```

归档包会写入 `dist/release/`，并生成 `SHA256SUMS.txt`。

为当前平台创建本地单文件可执行文件：

```bash
pnpm release:executable
```

创建指定平台的可执行文件：

```bash
pnpm release:executable -- --target=darwin-arm64
```

可执行文件会写入 `dist/executables/`。

## 许可证策略

默认情况下，Kakashi 只使用声明为宽松 SPDX 许可证的仓库：MIT、Apache-2.0、BSD、ISC 或 0BSD。传入 `--allow-copyleft` 可包含常见 copyleft 许可证。默认会排除未声明许可证的仓库。

## 项目许可证

Kakashi 使用 MIT License 发布。详见 `LICENSE`。

## 验证

本地检查：

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

真实集成检查：

```bash
RUN_REAL_INTEGRATION=1 pnpm test:integration
RUN_CODEX_INTEGRATION=1 pnpm test:codex
pnpm test:e2e
```

集成检查会使用真实 GitHub/Codex 命令，需要网络访问和有效的本地认证。

## 最终流程报告

每次完整运行都会在生成项目中写入 `KAKASHI_REPORT.md`。该报告包含原始需求、解析出的能力、分析过的 GitHub 仓库、每个仓库的用途和技术栈、选中的主项目/辅助项目、能力匹配、提供给 Codex 参考的源码区域、Codex 迭代摘要、验证尝试、修复回环状态和导出的产物。
