import type { Capability, CapabilityEdge, CapabilityGraph, RepoAnalysis } from "./types";

export class CapabilityGraphBuilder {
  build(capabilities: Capability[], analyses: RepoAnalysis[]): CapabilityGraph {
    const edges: CapabilityEdge[] = [];
    for (const analysis of analyses) {
      for (const match of analysis.capabilityMatches) {
        edges.push({
          capabilityId: match.capabilityId,
          repoFullName: analysis.candidate.fullName,
          confidence: match.confidence,
          evidence: match.evidence
        });
      }
    }

    const gaps = capabilities.filter((capability) => {
      const best = edges
        .filter((edge) => edge.capabilityId === capability.id)
        .reduce((max, edge) => Math.max(max, edge.confidence), 0);
      return best < 0.35;
    });

    return {
      capabilities,
      repos: analyses,
      edges: edges.sort((a, b) => b.confidence - a.confidence),
      gaps
    };
  }
}

