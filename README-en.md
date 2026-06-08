# Kakashi

Language: [简体中文](README.md) | English

Kakashi is a Codex-powered open-source capability fusion system. A user describes the software they want, Kakashi searches real GitHub repositories, analyzes repository capabilities, plans a fusion strategy, asks Codex CLI to modify code, verifies the generated project, and exports provenance plus verification reports.

Kakashi does not fork Codex CLI. It treats Codex CLI as the code execution engine and GitHub as the source of open-source capabilities.

## What It Builds

- Requirement parsing into target, stack, constraints, and capability nodes.
- Real GitHub repository search through Octokit and `gh`/token authentication.
- Real repository cloning and static analysis of manifests, commands, stack, modules, README evidence, and license metadata.
- Capability graph construction and main/auxiliary repository selection.
- Codex CLI execution through `codex exec` in the generated project.
- Verification of install/build/test/lint/start commands detected from actual project files.
- Gap detection from real verifier logs and follow-up GitHub search.
- CLI and local Web UI for full-auto and interactive runs.
- Exported full process documentation in `KAKASHI_REPORT.md`, plus `SOURCE_PROVENANCE.json`, `.kakashi/run-report.json`, and copied source license files.

## Requirements

For the single-file executable:

- Git
- GitHub CLI authenticated with `gh auth login`, or `GITHUB_TOKEN` / `GH_TOKEN`
- Codex CLI available as `codex`

The single-file executable bundles the Node.js runtime needed to start Kakashi. Generated projects may still need their own language runtimes and package managers during verification.

For release archives or source development:

- Node.js 24+
- Git
- GitHub CLI authenticated with `gh auth login`, or `GITHUB_TOKEN` / `GH_TOKEN`
- Codex CLI available as `codex`
- pnpm 10+ when developing from source

## Configuration

Kakashi does not have a separate Kakashi API key. It relies on two external authentication paths:

- GitHub authentication, used to search, inspect, and clone GitHub repositories.
- Codex authentication, used to run `codex exec` for code changes and repair loops.

### 1. Configure GitHub

The recommended path is GitHub CLI login:

```bash
gh auth login
gh auth status
```

For CI, servers, or non-interactive environments, use an environment variable:

```bash
export GH_TOKEN="github_pat_xxx"
# or
export GITHUB_TOKEN="github_pat_xxx"
```

Kakashi resolves GitHub authentication in this order:

1. `GITHUB_TOKEN`
2. `GH_TOKEN`
3. `gh auth token`

For public repositories, a normal GitHub CLI login is usually enough. For private repositories, make sure the token or logged-in GitHub account has access to those repositories.

### 2. Configure Codex

Kakashi calls the local `codex exec` command, so Codex CLI must work independently before Kakashi can execute real code changes.

Use browser/device login:

```bash
codex login
codex login status
```

Use an OpenAI API key:

```bash
export OPENAI_API_KEY="sk-..."
printenv OPENAI_API_KEY | codex login --with-api-key
codex login status
```

Or use a Codex access token:

```bash
export CODEX_ACCESS_TOKEN="..."
printenv CODEX_ACCESS_TOKEN | codex login --with-access-token
codex login status
```

Do not commit API keys, GitHub tokens, or access tokens to source code, README files, issues, logs, or generated projects. Use a system credential manager, CI secrets, shell session environment variables, or the credential storage managed by `gh auth login` / `codex login`.

### 3. Verify Configuration

Run:

```bash
kakashi doctor
```

If you use the single-file executable:

```bash
./kakashi-v0.2.0-darwin-arm64 doctor
```

If you run from source:

```bash
pnpm kakashi doctor
```

Expected successful checks include:

- `PASS git`
- `PASS gh`
- `PASS codex`
- `PASS github-auth`
- `PASS codex-version`
- `PASS gh-version`
- `PASS git-version`

### 4. Web UI Configuration

The Web UI does not have a separate API key configuration. It uses the same system environment and PATH as the Kakashi server process.

In the same terminal, verify:

```bash
gh auth status
codex login status
kakashi doctor
```

Then start the Web UI:

```bash
kakashi serve --port 4317
```

If you run the source development server, start the server from the same shell environment:

```bash
pnpm --filter @kakashi/server dev
pnpm --filter @kakashi/web dev
```

### 5. Optional Configuration

Specify a Codex model:

```bash
kakashi run "Build a TypeScript CLI with tests" --out ./generated --model <codex-model-name>
```

Adjust GitHub analysis size and repair loop count:

```bash
kakashi run "Build a dashboard" --out ./generated --max-repos 12 --max-iterations 3
```

Allow copyleft-licensed repositories:

```bash
kakashi run "Build a dashboard" --out ./generated --allow-copyleft
```

## Install From GitHub Release

Prefer downloading the single-file executable that matches your system:

- `kakashi-v0.2.0-linux-x64`
- `kakashi-v0.2.0-linux-arm64`
- `kakashi-v0.2.0-darwin-x64`
- `kakashi-v0.2.0-darwin-arm64`
- `kakashi-v0.2.0-windows-x64.exe`
- `kakashi-v0.2.0-windows-arm64.exe`

Verify downloads with the release `SHA256SUMS.txt` file.

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

The single-file executable embeds the Web UI. Start it with:

```bash
./kakashi-v0.2.0-darwin-arm64 serve --port 4317
```

Open `http://127.0.0.1:4317/`.

Release also includes full archive packages for users who prefer a directory with `README.md`, `README-en.md`, `INSTALL.md`, `LICENSE`, wrapper scripts, and Web UI files:

- `kakashi-v0.2.0-linux-x64.tar.gz`
- `kakashi-v0.2.0-linux-arm64.tar.gz`
- `kakashi-v0.2.0-darwin-x64.tar.gz`
- `kakashi-v0.2.0-darwin-arm64.tar.gz`
- `kakashi-v0.2.0-windows-x64.tar.gz`
- `kakashi-v0.2.0-windows-arm64.tar.gz`

Each archive contains a standalone Node-based Kakashi CLI bundle, the built Web UI, and an `INSTALL.md` file. Archives still require Node.js 24+, Git, GitHub CLI authentication, and Codex CLI at runtime.

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

To use the bundled Web UI from a release archive:

```bash
./bin/kakashi serve --web-dir ./web --port 4317
```

Open `http://127.0.0.1:4317/`.

## Source Setup

Run:

```bash
pnpm install
pnpm build
pnpm run doctor
```

## CLI

Full auto mode:

```bash
pnpm kakashi run \
  "Build a TypeScript web dashboard with GitHub search, capability graph, and live Codex execution logs" \
  --out ./generated-dashboard \
  --max-repos 12 \
  --max-iterations 3
```

Interactive mode:

```bash
pnpm kakashi interactive \
  "Build a local-first project management app with Kanban, calendar, and export" \
  --out ./generated-project
```

Inspect a previous run:

```bash
pnpm kakashi inspect <runId>
```

## Web UI

From source, start the API server:

```bash
pnpm --filter @kakashi/server dev
```

Start the Vite UI:

```bash
pnpm --filter @kakashi/web dev
```

Open `http://127.0.0.1:5173`.

For a production-style local Web UI after `pnpm build`, serve the built Web app through the CLI:

```bash
pnpm kakashi serve --web-dir apps/web/dist --port 4317
```

Open `http://127.0.0.1:4317`.

## Release Build

Create local full archive packages:

```bash
pnpm release:package
```

Release archives are written to `dist/release/` with `SHA256SUMS.txt`.

Create a local single-file executable for the current platform:

```bash
pnpm release:executable
```

Create a specific executable target:

```bash
pnpm release:executable -- --target=darwin-arm64
```

Executable assets are written to `dist/executables/`.

## License Policy

By default Kakashi only uses repositories with declared permissive SPDX licenses: MIT, Apache-2.0, BSD, ISC, or 0BSD. Pass `--allow-copyleft` to include common copyleft licenses. Repositories without a declared license are excluded by default.

## Project License

Kakashi is released under the MIT License. See `LICENSE`.

## Verification

Local checks:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Real integration checks:

```bash
RUN_REAL_INTEGRATION=1 pnpm test:integration
RUN_CODEX_INTEGRATION=1 pnpm test:codex
pnpm test:e2e
```

The integration checks use real GitHub/Codex commands. They require network access and valid local authentication.

## Final Process Report

Every completed run writes `KAKASHI_REPORT.md` into the generated project. It includes the original requirement, parsed capabilities, every GitHub repository analyzed, each repository's purpose and detected stack, selected main/auxiliary sources, capability matches, source areas prepared for Codex reference, Codex iteration summaries, verifier attempts, repair-loop status, and exported artifacts.
