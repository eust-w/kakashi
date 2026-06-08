import type {
  CapabilityGraph,
  FusionPlan,
  FusionPlanSource,
  FusionTask,
  KakashiOptions,
  RepoAnalysis,
  RepoCommand
} from "./types";

export class FusionPlanner {
  createPlan(graph: CapabilityGraph, options: Pick<KakashiOptions, "outputDir">): FusionPlan {
    if (graph.repos.length === 0) {
      throw new Error("Cannot create a fusion plan without repository analyses.");
    }

    const mainAnalysis = this.selectMain(graph);
    const auxiliaries = this.selectAuxiliaries(graph, mainAnalysis);
    const tasks = this.createTasks(graph, mainAnalysis, auxiliaries);

    return {
      requirement: {
        raw: graph.capabilities.map((capability) => capability.name).join(", "),
        goal: graph.capabilities.map((capability) => capability.name).join(", "),
        target: "unknown",
        preferredStack: [],
        capabilities: graph.capabilities,
        constraints: []
      },
      graph,
      main: this.toSource("main", mainAnalysis, graph),
      auxiliaries: auxiliaries.map((analysis) => this.toSource("auxiliary", analysis, graph)),
      tasks,
      verifierCommands: this.selectVerifierCommands(mainAnalysis.commands),
      outputDir: options.outputDir,
      createdAt: new Date().toISOString()
    };
  }

  createPlanForRequirement(
    graph: CapabilityGraph,
    requirement: FusionPlan["requirement"],
    options: Pick<KakashiOptions, "outputDir">
  ): FusionPlan {
    return { ...this.createPlan(graph, options), requirement };
  }

  private selectMain(graph: CapabilityGraph): RepoAnalysis {
    return [...graph.repos].sort((a, b) => this.repoScore(graph, b) - this.repoScore(graph, a))[0]!;
  }

  private selectAuxiliaries(graph: CapabilityGraph, main: RepoAnalysis): RepoAnalysis[] {
    const mainCaps = new Set(main.capabilityMatches.filter((match) => match.confidence >= 0.45).map((match) => match.capabilityId));
    const missing = graph.capabilities.filter((capability) => !mainCaps.has(capability.id));
    const selected = new Map<string, RepoAnalysis>();

    for (const capability of missing) {
      const bestEdge = graph.edges
        .filter((edge) => edge.capabilityId === capability.id && edge.repoFullName !== main.candidate.fullName)
        .sort((a, b) => b.confidence - a.confidence)[0];
      if (!bestEdge) continue;
      const analysis = graph.repos.find((repo) => repo.candidate.fullName === bestEdge.repoFullName);
      if (analysis) selected.set(analysis.candidate.fullName, analysis);
    }

    return [...selected.values()].slice(0, 5);
  }

  private createTasks(graph: CapabilityGraph, main: RepoAnalysis, auxiliaries: RepoAnalysis[]): FusionTask[] {
    const sourceList = [main, ...auxiliaries]
      .map((analysis) => `${analysis.candidate.fullName} at ${analysis.localPath}`)
      .join("\n");
    const capabilityList = graph.capabilities.map((capability) => `- ${capability.name}`).join("\n");
    const gapList = graph.gaps.map((capability) => `- ${capability.name}`).join("\n") || "- none";

    return [
      {
        title: "Understand target project and source capabilities",
        prompt: `Inspect the target project and these source repositories:\n${sourceList}\n\nRequired capabilities:\n${capabilityList}\n\nKnown capability gaps:\n${gapList}`,
        successCriteria: ["The implementation plan is grounded in real files from the target and source repositories."]
      },
      {
        title: "Fuse capabilities into the target project",
        prompt:
          "Integrate the auxiliary repository capabilities into the target project. Reuse real source ideas and APIs where compatible, preserve license provenance, and do not add mock, simulated, or hardcoded success paths.",
        successCriteria: [
          "The target project contains working code for each required capability.",
          "No fake repository data, fake Codex output, or hardcoded success result is introduced."
        ]
      },
      {
        title: "Make the fused project runnable and verified",
        prompt:
          "Install dependencies as needed, update scripts and documentation, run the project's build/test commands, and repair failures until the verifier can pass or a concrete external blocker is documented.",
        successCriteria: ["Install/build/test commands are runnable.", "Remaining failures include actionable logs and no hidden bypass."]
      }
    ];
  }

  private repoScore(graph: CapabilityGraph, analysis: RepoAnalysis): number {
    const coverage = graph.edges
      .filter((edge) => edge.repoFullName === analysis.candidate.fullName)
      .reduce((sum, edge) => sum + edge.confidence, 0);
    const readiness = analysis.commands.some((command) => command.purpose === "build") ? 1 : 0;
    const tests = analysis.commands.some((command) => command.purpose === "test") ? 1 : 0;
    return coverage * 20 + Math.log10(analysis.candidate.stars + 1) * 4 + readiness * 3 + tests * 2 - analysis.risks.length;
  }

  private toSource(role: FusionPlanSource["role"], analysis: RepoAnalysis, graph: CapabilityGraph): FusionPlanSource {
    const providedCapabilities = graph.edges
      .filter((edge) => edge.repoFullName === analysis.candidate.fullName && edge.confidence >= 0.3)
      .map((edge) => edge.capabilityId);
    return {
      role,
      repo: analysis.candidate,
      localPath: analysis.localPath,
      providedCapabilities,
      rationale: `${analysis.candidate.fullName} scored well for ${providedCapabilities.length} required capabilities with stack ${analysis.stack.join(", ") || "unknown"}.`
    };
  }

  private selectVerifierCommands(commands: RepoCommand[]): RepoCommand[] {
    const purposes: RepoCommand["purpose"][] = ["install", "lint", "build", "test"];
    return purposes.flatMap((purpose) => commands.filter((command) => command.purpose === purpose).slice(0, 1));
  }
}

