import { CapabilityGraphBuilder } from "./capability-graph";
import { FusionPlanner } from "./fusion-planner";
import type { KakashiRunState } from "./types";

export function applyInteractiveSelection(state: KakashiRunState, selectedRepositories: string[]): KakashiRunState {
  if (state.mode !== "interactive") {
    throw new Error("Repository selection is only available for interactive runs.");
  }
  if (state.stage !== "waiting_for_confirmation") {
    throw new Error("Repository selection is only available after the fusion plan is ready.");
  }
  const requirement = state.spec ?? state.plan?.requirement;
  if (!requirement) {
    throw new Error("Cannot rebuild the fusion plan before requirement parsing completes.");
  }
  if (!state.analyses?.length) {
    throw new Error("Cannot rebuild the fusion plan before repository analysis completes.");
  }

  const selected = new Set(selectedRepositories);
  const analyzed = new Set(state.analyses.map((analysis) => analysis.candidate.fullName));
  const missing = [...selected].filter((fullName) => !analyzed.has(fullName));
  if (missing.length > 0) {
    throw new Error(`Selected repository was not analyzed: ${missing.join(", ")}`);
  }

  const selectedAnalyses = state.analyses.filter((analysis) => selected.has(analysis.candidate.fullName));
  if (selectedAnalyses.length === 0) {
    throw new Error("At least one selected repository must match an analyzed repository.");
  }

  const graph = new CapabilityGraphBuilder().build(requirement.capabilities, selectedAnalyses);
  const plan = new FusionPlanner().createPlanForRequirement(graph, requirement, { outputDir: state.outputDir });
  return {
    ...state,
    stage: "waiting_for_confirmation",
    graph,
    plan,
    updatedAt: new Date().toISOString()
  };
}
