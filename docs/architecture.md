# Kakashi Architecture

Kakashi is an orchestration layer above Codex CLI. It does not generate canned project output; every production run uses live GitHub search, real repository clones, Codex CLI execution, and verifier command output from the generated project.

## Data Flow

1. `RequirementParser` converts the user request into a normalized goal, target, stack hints, constraints, and capability nodes.
2. `GitHubSearcher` authenticates through `GITHUB_TOKEN`, `GH_TOKEN`, or `gh auth token`, then searches GitHub repositories with Octokit. Bad credentials, transient network failures, and GitHub 5xx responses can fall back to `gh api` so local proxy/DNS paths that break Node fetch do not automatically fail the run when GitHub CLI is still reachable.
3. `RepoManager` clones source repositories into `~/.cache/kakashi/repos`.
   Cached repositories are refreshed with a real `git fetch` before reuse; refresh failures fail the run instead of silently using stale source code.
4. `RepoAnalyzer` reads manifests, README files, scripts, modules, and source layout from real files. It scans root files and common nested monorepo layouts with a bounded depth while skipping dependency/build directories, so repositories with `apps/*` or `services/*` manifests are analyzed without treating generated artifacts as source evidence.
5. `CapabilityGraphBuilder` links capability nodes to repository evidence.
6. `FusionPlanner` chooses a main repository and auxiliary repositories.
7. `RepoManager` clones the main repository into the output directory and auxiliary repositories under `.kakashi/sources`.
   Materialization uses the selected repository branch from GitHub metadata so the generated project matches the analyzed candidate.
8. `CodexExecutor` invokes `codex exec` in the output directory with the fusion plan and source paths.
   A non-zero Codex exit is a failed run even if the cloned source project already passes its own commands; Kakashi exports that failure instead of letting verifier success mask an incomplete fusion.
9. `Verifier` detects package manager and project commands from root and nested manifests, then runs install/build/test/lint/start checks. Kakashi combines detected Node, Python, Go, and Rust verification steps instead of stopping at the first ecosystem, and nested project checks execute from their own directories rather than from the repository root.
10. `GapDetector` extracts missing dependency/capability signals from real logs and can trigger another GitHub search iteration.
11. `Exporter` writes reports, provenance, and source license copies. Machine-readable and human-readable exported artifacts are redacted before writing so command output, Codex messages, requirements, and verifier summaries do not persist common API keys, tokens, passwords, or authorization headers.

## Local Prerequisite Checks

`kakashi doctor` validates required commands with executable permission checks, not just same-name file existence on `PATH`. This prevents ordinary files named `git`, `gh`, `codex`, `node`, or `pnpm` from being reported as usable tools.

## State

Run state is stored under `.kakashi/runs/<runId>`:

- `state.json` contains the latest run state.
- `events.jsonl` is append-only and powers CLI/Web progress logs.

CLI inspection commands read this store directly:

- `kakashi runs` lists runs for the current workspace by latest update time, so newly completed or failed older runs remain easy to find.
- `kakashi inspect <runId>` prints the latest run state as JSON by default, including structured stderr errors for missing runs.
- `kakashi events <runId>` prints the append-only event log.
- `--json` on supported commands produces clean machine-readable output for scripts and CI.
- CLI JSON mode writes successful payloads to stdout and structured errors to stderr, which lets shell scripts safely pipe stdout without losing diagnostics.
- Run IDs are opaque store keys and may contain only letters, numbers, `_`, and `-`; the store rejects path-like IDs before reading or writing state files, and run listing ignores unrelated directories in the run store.
- CLI output directories may be inside or outside the workspace, but they must not be the workspace itself or one of its parent directories. This prevents `--force` from clearing the active project tree.

## Server API Runtime

- Auto runs stay active only while background orchestration is running.
- Interactive runs stay active only after preparation succeeds and the plan is waiting for confirmation.
- If interactive preparation fails, Kakashi persists the failed state and removes the in-memory active run entry; later confirmation requests return `404` instead of acting on a stale orchestrator.
- Event streams validate that the run exists before opening the SSE connection; missing run IDs return `404` immediately instead of creating an empty live stream.

Generated projects contain:

- `.kakashi/fusion-plan.json`
- `.kakashi/run-report.json`
- `.kakashi/licenses/*`
- `SOURCE_PROVENANCE.json`
- `KAKASHI_REPORT.md` human-readable full process report: requirement, analyzed GitHub projects, source selection, capability matches, Codex iterations, verifier attempts, and loop status.
