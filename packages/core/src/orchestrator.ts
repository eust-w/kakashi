import { join, resolve } from "node:path";
import type {
  Capability,
  CodexResult,
  FusionPlan,
  KakashiOptions,
  KakashiRunState,
  RepoAnalysis,
  RepoCandidate,
  RunEvent,
  RunMode,
  VerificationResult
} from "./types";
import { RequirementParser } from "./requirement-parser";
import { GitHubSearcher } from "./github-searcher";
import { RepoManager } from "./repo-manager";
import { RepoAnalyzer } from "./repo-analyzer";
import { CapabilityGraphBuilder } from "./capability-graph";
import { FusionPlanner } from "./fusion-planner";
import { CodexExecutor } from "./codex-executor";
import { Verifier } from "./verifier";
import { GapDetector } from "./gap-detector";
import { Exporter } from "./exporter";
import { RunStore } from "./run-store";
import { KakashiError } from "./errors";
import { emptyDir, ensureDir, isDirectoryEmpty, pathExists, writeJsonFile } from "./utils/fs";
import { redactObject } from "./utils/redaction";

export interface OrchestratorOptions extends Partial<KakashiOptions> {
  workDir?: string;
  onEvent?: (event: RunEvent) => void;
}

export interface PreparedRun {
  state: KakashiRunState;
  candidates: RepoCandidate[];
  analyses: RepoAnalysis[];
  plan: FusionPlan;
}

const DEFAULT_TIMEOUT = 300_000;

export class KakashiOrchestrator {
  private readonly abortController = new AbortController();
  private readonly parser = new RequirementParser();
  private readonly searcher = new GitHubSearcher();
  private readonly repoManager = new RepoManager();
  private readonly analyzer = new RepoAnalyzer();
  private readonly graphBuilder = new CapabilityGraphBuilder();
  private readonly planner = new FusionPlanner();
  private readonly codex = new CodexExecutor();
  private readonly verifier = new Verifier();
  private readonly gapDetector = new GapDetector();
  private readonly exporter = new Exporter();
  readonly store: RunStore;

  constructor(private readonly options: OrchestratorOptions) {
    const workDir = resolve(options.workDir ?? process.cwd());
    this.store = new RunStore(join(workDir, ".kakashi", "runs"));
  }

  cancel(): void {
    this.abortController.abort();
  }

  async run(requirementText: string, mode: RunMode = "auto"): Promise<KakashiRunState> {
    const state = await this.createState(requirementText, mode);
    return await this.runState(state);
  }

  async createState(requirementText: string, mode: RunMode = "auto"): Promise<KakashiRunState> {
    const opts = this.resolveOptions();
    return await this.store.create(mode, requirementText, opts.outputDir);
  }

  async runState(state: KakashiRunState): Promise<KakashiRunState> {
    const opts = this.resolveOptions();
    try {
      const prepared = await this.prepareExisting(state, opts);
      const finalState = await this.executePrepared(prepared.state, prepared.plan, opts);
      return finalState;
    } catch (error) {
      return await this.fail(state, error);
    }
  }

  async prepare(requirementText: string, mode: RunMode = "interactive"): Promise<PreparedRun> {
    const state = await this.createState(requirementText, mode);
    return await this.prepareState(state);
  }

  async prepareState(state: KakashiRunState): Promise<PreparedRun> {
    const opts = this.resolveOptions();
    try {
      return await this.prepareExisting(state, opts);
    } catch (error) {
      await this.fail(state, error);
      throw error;
    }
  }

  async executePrepared(state: KakashiRunState, plan: FusionPlan, opts = this.resolveOptions()): Promise<KakashiRunState> {
    this.throwIfCancelled();
    await this.emit(state, "materializing", "info", "Materializing target project from the selected main repository.");
    await this.materialize(plan, opts);
    this.throwIfCancelled();

    const codexRuns: CodexResult[] = [];
    let verification: VerificationResult = {
      ok: false,
      steps: [],
      summary: "Verification did not run."
    };
    const verificationAttempts: VerificationResult[] = [];

    for (let iteration = 1; iteration <= opts.maxIterations; iteration += 1) {
      await this.emit(state, "executing", "info", `Running Codex fusion iteration ${iteration}.`);
      const instruction =
        iteration === 1
          ? "Implement the fusion plan end to end, then run the detected project verification commands."
          : `Repair the real verification failures from the previous iteration. Do not bypass the failing command.`;

      const codexResult = await this.codex.execute(plan, instruction, {
        cwd: plan.outputDir,
        timeoutMs: opts.commandTimeoutMs,
        model: opts.codexModel,
        signal: opts.signal,
        onEvent: (event) => {
          void this.emit(state, "executing", "info", "Codex event", event);
        },
        onText: (text) => {
          if (text.trim()) void this.emit(state, "executing", "info", text.trim().slice(0, 2_000));
        }
      });
      codexRuns.push(codexResult);
      this.throwIfCancelled();

      await this.emit(state, "verifying", "info", "Running real project verification commands.");
      verification = await this.verifier.verify(plan.outputDir, opts.commandTimeoutMs, opts.signal);
      verificationAttempts.push(verification);
      this.throwIfCancelled();
      await this.emit(state, "verifying", verification.ok ? "info" : "warn", verification.summary, verification);
      if (verification.ok) break;

      const logs = verification.steps.map((step) => `${step.name}\n${step.result.stdout}\n${step.result.stderr}`).join("\n");
      const gaps = this.gapDetector.detect(logs, plan.requirement.capabilities);
      if (gaps.length > 0 && iteration < opts.maxIterations) {
        await this.extendPlanWithGaps(state, plan, gaps, opts);
      }
    }

    await this.emit(state, "exporting", "info", "Writing provenance and verification reports.");
    const report = await this.exporter.exportReport(state.runId, plan, verification, codexRuns, verificationAttempts);
    const completed: KakashiRunState = {
      ...state,
      stage: verification.ok ? "completed" : "failed",
      plan,
      report,
      error: verification.ok ? undefined : verification.summary
    };
    await this.store.save(completed);
    await this.emit(completed, completed.stage, verification.ok ? "info" : "error", verification.ok ? "Run completed." : verification.summary);
    return completed;
  }

  private async prepareExisting(state: KakashiRunState, opts: KakashiOptions): Promise<PreparedRun> {
    this.throwIfCancelled();
    await ensureDir(opts.cacheDir);
    await this.emit(state, "parsing", "info", "Parsing requirement.");
    const spec = this.parser.parse(state.requirementText);
    await this.store.save({ ...state, stage: "parsing", spec });

    await this.emit(state, "searching", "info", "Searching GitHub for source repositories.");
    this.throwIfCancelled();
    const candidates = await this.searcher.search(spec, {
      cwd: opts.workDir,
      maxRepos: opts.maxRepos,
      allowCopyleft: opts.allowCopyleft
    });
    this.throwIfCancelled();
    if (candidates.length === 0) {
      throw new KakashiError("NO_REPOS_FOUND", "No repositories matched the requirement and license policy.");
    }
    await this.store.save({ ...state, stage: "searching", spec, candidates });

    await this.emit(state, "analyzing", "info", `Cloning and analyzing ${candidates.length} repository candidate(s).`);
    const analyses: RepoAnalysis[] = [];
    for (const candidate of candidates) {
      this.throwIfCancelled();
      const localPath = await this.repoManager.cloneToCache(candidate, opts.cacheDir, opts.commandTimeoutMs, opts.signal);
      analyses.push(await this.analyzer.analyze(candidate, localPath, spec.capabilities));
      await this.emit(state, "analyzing", "info", `Analyzed ${candidate.fullName}.`);
    }

    const graph = this.graphBuilder.build(spec.capabilities, analyses);
    const plan = this.planner.createPlanForRequirement(graph, spec, { outputDir: opts.outputDir });
    const preparedState: KakashiRunState = {
      ...state,
      stage: state.mode === "interactive" ? "waiting_for_confirmation" : "planning",
      spec,
      candidates,
      analyses,
      graph,
      plan
    };
    await this.store.save(preparedState);
    await this.emit(preparedState, preparedState.stage, "info", "Fusion plan is ready.", plan);
    return { state: preparedState, candidates, analyses, plan };
  }

  private async materialize(plan: FusionPlan, opts: KakashiOptions): Promise<void> {
    if (await pathExists(opts.outputDir)) {
      if (opts.force) {
        await emptyDir(opts.outputDir);
      } else if (!(await isDirectoryEmpty(opts.outputDir))) {
        throw new KakashiError("OUTPUT_DIR_NOT_EMPTY", `Output directory is not empty: ${opts.outputDir}`);
      }
    }

    if (await isDirectoryEmpty(opts.outputDir)) {
      await this.repoManager.cloneMainToOutput(plan.main.repo, opts.outputDir, opts.commandTimeoutMs, opts.signal);
    }

    const sourcesDir = join(opts.outputDir, ".kakashi", "sources");
    await ensureDir(sourcesDir);
    for (const source of plan.auxiliaries) {
      this.throwIfCancelled();
      source.localPath = await this.repoManager.cloneAuxiliary(source.repo, sourcesDir, opts.commandTimeoutMs, opts.signal);
    }
    await writeJsonFile(join(opts.outputDir, ".kakashi", "fusion-plan.json"), redactObject(plan));
  }

  private async extendPlanWithGaps(
    state: KakashiRunState,
    plan: FusionPlan,
    gaps: Capability[],
    opts: KakashiOptions
  ): Promise<void> {
    await this.emit(state, "searching", "warn", `Detected ${gaps.length} missing capability/dependency gap(s); searching GitHub again.`, gaps);
    const nextSpec = {
      ...plan.requirement,
      capabilities: [...plan.requirement.capabilities, ...gaps]
    };
    const candidates = await this.searcher.search(nextSpec, {
      cwd: opts.workDir,
      maxRepos: Math.min(5, opts.maxRepos),
      allowCopyleft: opts.allowCopyleft
    });
    const known = new Set([plan.main.repo.fullName, ...plan.auxiliaries.map((source) => source.repo.fullName)]);
    for (const candidate of candidates.filter((candidate) => !known.has(candidate.fullName)).slice(0, 2)) {
      this.throwIfCancelled();
      const localPath = await this.repoManager.cloneAuxiliary(candidate, join(opts.outputDir, ".kakashi", "sources"), opts.commandTimeoutMs, opts.signal);
      plan.auxiliaries.push({
        role: "auxiliary",
        repo: candidate,
        localPath,
        providedCapabilities: gaps.map((gap) => gap.id),
        rationale: `Added after verifier detected gap(s): ${gaps.map((gap) => gap.name).join(", ")}.`
      });
      await this.emit(state, "analyzing", "info", `Added gap source ${candidate.fullName}.`);
    }
    plan.requirement = nextSpec;
    await writeJsonFile(join(opts.outputDir, ".kakashi", "fusion-plan.json"), redactObject(plan));
  }

  private resolveOptions(): KakashiOptions {
    const workDir = resolve(this.options.workDir ?? process.cwd());
    return {
      workDir,
      cacheDir: resolve(this.options.cacheDir ?? join(process.env.HOME ?? workDir, ".cache", "kakashi", "repos")),
      outputDir: resolve(this.options.outputDir ?? join(workDir, "kakashi-output")),
      maxRepos: this.options.maxRepos ?? 12,
      maxIterations: this.options.maxIterations ?? 3,
      allowCopyleft: this.options.allowCopyleft ?? false,
      force: this.options.force ?? false,
      codexModel: this.options.codexModel,
      commandTimeoutMs: this.options.commandTimeoutMs ?? DEFAULT_TIMEOUT,
      signal: this.abortController.signal
    };
  }

  private throwIfCancelled(): void {
    if (this.abortController.signal.aborted) {
      throw new KakashiError("RUN_CANCELLED", "Run cancelled by user.");
    }
  }

  private async emit(
    state: KakashiRunState,
    stage: KakashiRunState["stage"],
    level: RunEvent["level"],
    message: string,
    data?: unknown
  ): Promise<void> {
    const event = await this.store.appendEvent(state.runId, stage, level, message, data);
    this.options.onEvent?.(event);
  }

  private async fail(state: KakashiRunState, error: unknown): Promise<KakashiRunState> {
    const message = error instanceof Error ? error.message : String(error);
    const failed = {
      ...state,
      stage: error instanceof KakashiError && error.code === "RUN_CANCELLED" ? "cancelled" as const : "failed" as const,
      error: message
    };
    await this.store.save(failed);
    await this.emit(failed, "failed", "error", message, error instanceof KakashiError ? error.details : undefined);
    return failed;
  }
}
