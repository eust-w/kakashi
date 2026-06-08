export type RunMode = "auto" | "interactive";

export type RunStage =
  | "created"
  | "parsing"
  | "searching"
  | "analyzing"
  | "planning"
  | "waiting_for_selection"
  | "waiting_for_confirmation"
  | "materializing"
  | "executing"
  | "verifying"
  | "exporting"
  | "completed"
  | "failed"
  | "cancelled";

export interface Capability {
  id: string;
  name: string;
  description: string;
  keywords: string[];
  required: boolean;
}

export interface RequirementSpec {
  raw: string;
  goal: string;
  target: "web" | "cli" | "api" | "desktop" | "mobile" | "library" | "unknown";
  preferredStack: string[];
  capabilities: Capability[];
  constraints: string[];
}

export interface KakashiOptions {
  cacheDir: string;
  outputDir: string;
  workDir: string;
  maxRepos: number;
  maxIterations: number;
  allowCopyleft: boolean;
  force: boolean;
  codexModel?: string;
  commandTimeoutMs: number;
}

export interface GitHubRepoOwner {
  login: string;
}

export interface RepoCandidate {
  id: number;
  fullName: string;
  owner: string;
  name: string;
  htmlUrl: string;
  cloneUrl: string;
  defaultBranch: string;
  description: string;
  stars: number;
  forks: number;
  openIssues: number;
  sizeKb?: number;
  language: string | null;
  license: string | null;
  updatedAt: string;
  pushedAt: string | null;
  archived: boolean;
  fork: boolean;
  score: number;
  matchedCapabilities: string[];
}

export interface RepoModule {
  path: string;
  kind: "source" | "test" | "config" | "docs" | "package";
  summary: string;
}

export interface RepoCommand {
  name: string;
  command: string;
  source: string;
  purpose: "install" | "build" | "test" | "lint" | "start" | "dev" | "other";
}

export interface RepoCapabilityMatch {
  capabilityId: string;
  capabilityName: string;
  confidence: number;
  evidence: string[];
}

export interface RepoAnalysis {
  candidate: RepoCandidate;
  localPath: string;
  stack: string[];
  packageManagers: string[];
  manifests: string[];
  commands: RepoCommand[];
  modules: RepoModule[];
  readmeSummary: string;
  capabilityMatches: RepoCapabilityMatch[];
  risks: string[];
}

export interface CapabilityEdge {
  capabilityId: string;
  repoFullName: string;
  confidence: number;
  evidence: string[];
}

export interface CapabilityGraph {
  capabilities: Capability[];
  repos: RepoAnalysis[];
  edges: CapabilityEdge[];
  gaps: Capability[];
}

export interface FusionPlanSource {
  role: "main" | "auxiliary";
  repo: RepoCandidate;
  localPath: string;
  providedCapabilities: string[];
  rationale: string;
}

export interface FusionTask {
  title: string;
  prompt: string;
  successCriteria: string[];
}

export interface FusionPlan {
  requirement: RequirementSpec;
  graph: CapabilityGraph;
  main: FusionPlanSource;
  auxiliaries: FusionPlanSource[];
  tasks: FusionTask[];
  verifierCommands: RepoCommand[];
  outputDir: string;
  createdAt: string;
}

export interface CommandResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface VerificationStep {
  name: string;
  command: string[];
  required: boolean;
  mode?: "exit" | "readiness";
}

export interface VerificationResult {
  ok: boolean;
  steps: Array<{
    name: string;
    command: string;
    ok: boolean;
    result: CommandResult;
  }>;
  summary: string;
}

export interface CodexResult {
  ok: boolean;
  exitCode: number | null;
  finalMessage: string;
  events: unknown[];
  result: CommandResult;
}

export interface RunEvent {
  id: string;
  runId: string;
  timestamp: string;
  stage: RunStage;
  level: "info" | "warn" | "error";
  message: string;
  data?: unknown;
}

export interface RunReport {
  runId: string;
  requirement: RequirementSpec;
  plan: FusionPlan;
  verification: VerificationResult;
  verificationAttempts: VerificationResult[];
  codexRuns: CodexResult[];
  outputDir: string;
  completedAt: string;
}

export interface KakashiRunState {
  runId: string;
  mode: RunMode;
  stage: RunStage;
  requirementText: string;
  outputDir: string;
  createdAt: string;
  updatedAt: string;
  spec?: RequirementSpec;
  candidates?: RepoCandidate[];
  analyses?: RepoAnalysis[];
  graph?: CapabilityGraph;
  plan?: FusionPlan;
  report?: RunReport;
  error?: string;
}
