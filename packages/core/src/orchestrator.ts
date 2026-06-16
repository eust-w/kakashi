import { join, resolve } from "node:path";
import type {
  Capability,
  CapabilityGraph,
  CodexResult,
  FusionPlan,
  KakashiOptions,
  KakashiRunState,
  RepoAnalysis,
  RepoCandidate,
  RunReport,
  RunEvent,
  RunMode,
  RequirementSpec,
  VerificationResult
} from "./types";
import { RunStore } from "./run-store";
import { KakashiError } from "./errors";
import { emptyDir, ensureDir, isDirectoryEmpty, pathExists, writeJsonFile } from "./utils/fs";
import { redactObject } from "./utils/redaction";

export interface OrchestratorOptions extends Partial<KakashiOptions> {
  workDir?: string;
  onEvent?: (event: RunEvent) => void;
  services?: Partial<OrchestratorServices>;
}

export interface PreparedRun {
  state: KakashiRunState;
  candidates: RepoCandidate[];
  analyses: RepoAnalysis[];
  plan: FusionPlan;
}

export interface OrchestratorServices {
  parser: { parse(input: string): RequirementSpec };
  searcher: {
    search(
      spec: RequirementSpec,
      options: { cwd: string; maxRepos: number; allowCopyleft: boolean }
    ): Promise<RepoCandidate[]>;
  };
  repoManager: {
    cloneToCache(candidate: RepoCandidate, cacheDir: string, timeoutMs: number, signal?: AbortSignal): Promise<string>;
    cloneMainToOutput(candidate: RepoCandidate, outputDir: string, timeoutMs: number, signal?: AbortSignal): Promise<void>;
    cloneAuxiliary(candidate: RepoCandidate, sourcesDir: string, timeoutMs: number, signal?: AbortSignal): Promise<string>;
  };
  analyzer: { analyze(candidate: RepoCandidate, localPath: string, capabilities: Capability[]): Promise<RepoAnalysis> };
  graphBuilder: { build(capabilities: Capability[], analyses: RepoAnalysis[]): CapabilityGraph };
  planner: { createPlanForRequirement(graph: CapabilityGraph, spec: RequirementSpec, options: { outputDir: string }): FusionPlan };
  codex: {
    execute(
      plan: FusionPlan,
      instruction: string,
      options: {
        cwd: string;
        timeoutMs: number;
        model?: string;
        signal?: AbortSignal;
        onEvent?: (event: unknown) => void;
        onText?: (text: string) => void;
      }
    ): Promise<CodexResult>;
  };
  verifier: { verify(projectDir: string, timeoutMs: number, signal?: AbortSignal): Promise<VerificationResult> };
  gapDetector: { detect(logs: string, capabilities: Capability[]): Capability[] };
  exporter: {
    exportReport(
      runId: string,
      plan: FusionPlan,
      verification: VerificationResult,
      codexRuns: CodexResult[],
      verificationAttempts: VerificationResult[],
      runEvents: RunEvent[]
    ): Promise<RunReport>;
  };
}

const DEFAULT_TIMEOUT = 300_000;

export class KakashiOrchestrator {
  private readonly abortController = new AbortController();
  private readonly services: Partial<OrchestratorServices>;
  readonly store: RunStore;

  constructor(private readonly options: OrchestratorOptions) {
    const workDir = resolve(options.workDir ?? process.cwd());
    this.services = { ...options.services };
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

      const codexResult = await (await this.getCodex()).execute(plan, instruction, {
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
      if (!codexResult.ok) {
        verification = codexFailureVerification(codexResult);
        verificationAttempts.push(verification);
        await this.emit(state, "executing", "error", verification.summary, codexResult);
        break;
      }

      await this.emit(state, "verifying", "info", "Running real project verification commands.");
      verification = await (await this.getVerifier()).verify(plan.outputDir, opts.commandTimeoutMs, opts.signal);
      verificationAttempts.push(verification);
      this.throwIfCancelled();
      await this.emit(state, "verifying", verification.ok ? "info" : "warn", verification.summary, verification);
      if (verification.ok) break;

      const logs = verification.steps.map((step) => `${step.name}\n${step.result.stdout}\n${step.result.stderr}`).join("\n");
      const gaps = (await this.getGapDetector()).detect(logs, plan.requirement.capabilities);
      if (gaps.length > 0 && iteration < opts.maxIterations) {
        await this.extendPlanWithGaps(state, plan, gaps, opts);
      }
    }

    await this.emit(state, "exporting", "info", "Writing provenance and verification reports.");
    const runEvents = await this.store.events(state.runId);
    const report = await (await this.getExporter()).exportReport(state.runId, plan, verification, codexRuns, verificationAttempts, runEvents);
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
    const spec = (await this.getParser()).parse(state.requirementText);
    await this.store.save({ ...state, stage: "parsing", spec });

    await this.emit(state, "searching", "info", "Searching GitHub for source repositories.");
    this.throwIfCancelled();
    const candidates = await (await this.getSearcher()).search(spec, {
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
      try {
        const localPath = await (await this.getRepoManager()).cloneToCache(candidate, opts.cacheDir, opts.commandTimeoutMs, opts.signal);
        analyses.push(await (await this.getAnalyzer()).analyze(candidate, localPath, spec.capabilities));
        await this.emit(state, "analyzing", "info", `Analyzed ${candidate.fullName}.`);
      } catch (error) {
        this.throwIfCancelled();
        const message = error instanceof Error ? error.message : String(error);
        await this.emit(state, "analyzing", "warn", `Skipped ${candidate.fullName}: ${message}`, errorDetails(error));
      }
    }

    if (analyses.length === 0) {
      throw new KakashiError("NO_REPOS_ANALYZED", "No repository candidates could be cloned and analyzed.");
    }

    const graph = (await this.getGraphBuilder()).build(spec.capabilities, analyses);
    const plan = (await this.getPlanner()).createPlanForRequirement(graph, spec, { outputDir: opts.outputDir });
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
      await (await this.getRepoManager()).cloneMainToOutput(plan.main.repo, opts.outputDir, opts.commandTimeoutMs, opts.signal);
    }

    const sourcesDir = join(opts.outputDir, ".kakashi", "sources");
    await ensureDir(sourcesDir);
    for (const source of plan.auxiliaries) {
      this.throwIfCancelled();
      source.localPath = await (await this.getRepoManager()).cloneAuxiliary(source.repo, sourcesDir, opts.commandTimeoutMs, opts.signal);
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
    const candidates = await (await this.getSearcher()).search(nextSpec, {
      cwd: opts.workDir,
      maxRepos: Math.min(5, opts.maxRepos),
      allowCopyleft: opts.allowCopyleft
    });
    const known = new Set([plan.main.repo.fullName, ...plan.auxiliaries.map((source) => source.repo.fullName)]);
    for (const candidate of candidates.filter((candidate) => !known.has(candidate.fullName)).slice(0, 2)) {
      this.throwIfCancelled();
      const localPath = await (await this.getRepoManager()).cloneAuxiliary(candidate, join(opts.outputDir, ".kakashi", "sources"), opts.commandTimeoutMs, opts.signal);
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

  private async getParser(): Promise<OrchestratorServices["parser"]> {
    if (!this.services.parser) {
      const { RequirementParser } = await import("./requirement-parser");
      this.services.parser = new RequirementParser();
    }
    return this.services.parser;
  }

  private async getSearcher(): Promise<OrchestratorServices["searcher"]> {
    if (!this.services.searcher) {
      const { GitHubSearcher } = await import("./github-searcher");
      this.services.searcher = new GitHubSearcher();
    }
    return this.services.searcher;
  }

  private async getRepoManager(): Promise<OrchestratorServices["repoManager"]> {
    if (!this.services.repoManager) {
      const { RepoManager } = await import("./repo-manager");
      this.services.repoManager = new RepoManager();
    }
    return this.services.repoManager;
  }

  private async getAnalyzer(): Promise<OrchestratorServices["analyzer"]> {
    if (!this.services.analyzer) {
      const { RepoAnalyzer } = await import("./repo-analyzer");
      this.services.analyzer = new RepoAnalyzer();
    }
    return this.services.analyzer;
  }

  private async getGraphBuilder(): Promise<OrchestratorServices["graphBuilder"]> {
    if (!this.services.graphBuilder) {
      const { CapabilityGraphBuilder } = await import("./capability-graph");
      this.services.graphBuilder = new CapabilityGraphBuilder();
    }
    return this.services.graphBuilder;
  }

  private async getPlanner(): Promise<OrchestratorServices["planner"]> {
    if (!this.services.planner) {
      const { FusionPlanner } = await import("./fusion-planner");
      this.services.planner = new FusionPlanner();
    }
    return this.services.planner;
  }

  private async getCodex(): Promise<OrchestratorServices["codex"]> {
    if (!this.services.codex) {
      const { CodexExecutor } = await import("./codex-executor");
      this.services.codex = new CodexExecutor();
    }
    return this.services.codex;
  }

  private async getVerifier(): Promise<OrchestratorServices["verifier"]> {
    if (!this.services.verifier) {
      const { Verifier } = await import("./verifier");
      this.services.verifier = new Verifier();
    }
    return this.services.verifier;
  }

  private async getGapDetector(): Promise<OrchestratorServices["gapDetector"]> {
    if (!this.services.gapDetector) {
      const { GapDetector } = await import("./gap-detector");
      this.services.gapDetector = new GapDetector();
    }
    return this.services.gapDetector;
  }

  private async getExporter(): Promise<OrchestratorServices["exporter"]> {
    if (!this.services.exporter) {
      const { Exporter } = await import("./exporter");
      this.services.exporter = new Exporter();
    }
    return this.services.exporter;
  }
}

function errorDetails(error: unknown): unknown {
  return error instanceof KakashiError ? error.details : undefined;
}

function codexFailureVerification(codexResult: CodexResult): VerificationResult {
  const reason = codexResult.result.timedOut
    ? "timed out"
    : `exited with code ${codexResult.exitCode ?? "unknown"}`;
  return {
    ok: false,
    steps: [],
    summary: `Codex execution failed (${reason}); project verification was not run because code modification did not complete.`
  };
}
