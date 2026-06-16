# Kakashi Architecture

Kakashi is an orchestration layer above Codex CLI. It does not generate canned project output; every production run uses live GitHub search, real repository clones, Codex CLI execution, and verifier command output from the generated project.

## Data Flow

1. `RequirementParser` converts the user request into a normalized goal, target, stack hints, constraints, and capability nodes.
2. `GitHubSearcher` authenticates through `GITHUB_TOKEN`, `GH_TOKEN`, or `gh auth token`, then searches GitHub repositories with Octokit.
3. `RepoManager` clones source repositories into `~/.cache/kakashi/repos`.
4. `RepoAnalyzer` reads manifests, README files, scripts, modules, and source layout from real files.
5. `CapabilityGraphBuilder` links capability nodes to repository evidence.
6. `FusionPlanner` chooses a main repository and auxiliary repositories.
7. `RepoManager` clones the main repository into the output directory and auxiliary repositories under `.kakashi/sources`.
8. `CodexExecutor` invokes `codex exec` in the output directory with the fusion plan and source paths.
9. `Verifier` detects package manager and project commands from manifests and runs install/build/test/lint/start checks.
10. `GapDetector` extracts missing dependency/capability signals from real logs and can trigger another GitHub search iteration.
11. `Exporter` writes reports, provenance, and source license copies.

## State

Run state is stored under `.kakashi/runs/<runId>`:

- `state.json` contains the latest run state.
- `events.jsonl` is append-only and powers CLI/Web progress logs.

CLI inspection commands read this store directly:

- `kakashi runs` lists recent runs for the current workspace.
- `kakashi inspect <runId>` prints the latest run state.
- `kakashi events <runId>` prints the append-only event log.
- `--json` on supported commands produces clean machine-readable output for scripts and CI.
- CLI JSON mode writes successful payloads to stdout and structured errors to stderr, which lets shell scripts safely pipe stdout without losing diagnostics.
- Run IDs are opaque store keys and may contain only letters, numbers, `_`, and `-`; the store rejects path-like IDs before reading or writing state files, and run listing ignores unrelated directories in the run store.
- CLI output directories may be inside or outside the workspace, but they must not be the workspace itself or one of its parent directories. This prevents `--force` from clearing the active project tree.

## Server API Runtime

- Auto runs stay active only while background orchestration is running.
- Interactive runs stay active only after preparation succeeds and the plan is waiting for confirmation.
- If interactive preparation fails, Kakashi persists the failed state and removes the in-memory active run entry; later confirmation requests return `404` instead of acting on a stale orchestrator.

Generated projects contain:

- `.kakashi/fusion-plan.json`
- `.kakashi/run-report.json`
- `.kakashi/licenses/*`
- `SOURCE_PROVENANCE.json`
- `KAKASHI_REPORT.md` human-readable full process report: requirement, analyzed GitHub projects, source selection, capability matches, Codex iterations, verifier attempts, and loop status.
