import type { RequirementSpec } from "./types";

export interface RepositoryScoreExplanation {
  total: number;
  breakdown: Record<
    "stars" | "forks" | "freshness" | "matchedCapabilities" | "directTermHits" | "targetBoost" | "stackBoost" | "issuePenalty" | "sizePenalty",
    number
  >;
  reason: string;
}

export function explainRepositoryScore(
  item: {
    stargazers_count?: number;
    forks_count?: number;
    open_issues_count?: number;
    pushed_at?: string | null;
    language?: string | null;
    full_name?: string;
    name?: string;
    description?: string | null;
    size?: number;
  },
  matchedCapabilityCount: number,
  spec: RequirementSpec
): RepositoryScoreExplanation {
  const stars = Math.log10((item.stargazers_count ?? 0) + 1) * 5;
  const forks = Math.log10((item.forks_count ?? 0) + 1);
  const freshness = item.pushed_at
    ? Math.max(0, 12 - (Date.now() - Date.parse(item.pushed_at)) / (1000 * 60 * 60 * 24 * 60))
    : 0;
  const nameDescription = `${item.full_name ?? ""} ${item.name ?? ""} ${item.description ?? ""}`.toLowerCase();
  const terms = meaningfulTermsForSpec(spec);
  const directTermHitCount = terms.filter((term) => nameDescription.includes(term)).length;
  const targetBoost =
    spec.target === "unknown" || nameDescription.includes(spec.target)
      ? 5
      : spec.target === "cli" && /\b(cli|command|terminal|shell)\b/i.test(nameDescription)
        ? 8
        : 0;
  const stackBoost = spec.preferredStack.some((stack) => item.language?.toLowerCase().includes(stack)) ? 5 : 0;
  const sizePenalty = Math.log10((item.size ?? 0) + 1) * 3.5;
  const issuePenalty = Math.log10((item.open_issues_count ?? 0) + 1);
  const matchedCapabilities = matchedCapabilityCount * 5;
  const breakdown = {
    stars,
    forks,
    freshness,
    matchedCapabilities,
    directTermHits: directTermHitCount * 12,
    targetBoost,
    stackBoost,
    issuePenalty,
    sizePenalty
  };
  const total =
    breakdown.stars +
    breakdown.forks +
    breakdown.freshness +
    breakdown.matchedCapabilities +
    breakdown.directTermHits +
    breakdown.targetBoost +
    breakdown.stackBoost -
    breakdown.issuePenalty -
    breakdown.sizePenalty;
  const positiveReasons = [
    directTermHitCount > 0 ? `${directTermHitCount} direct term hits` : null,
    matchedCapabilityCount > 0 ? `${matchedCapabilityCount} capability match(es)` : null,
    stackBoost > 0 ? "stack match" : null,
    freshness > 0 ? "recent activity" : null,
    stars > 0 ? "repository stars" : null
  ].filter((reason): reason is string => Boolean(reason));
  const penalties = [issuePenalty > 0 ? "open issue penalty" : null, sizePenalty > 0 ? "repository size penalty" : null].filter(
    (reason): reason is string => Boolean(reason)
  );
  return {
    total,
    breakdown,
    reason: `${positiveReasons.join(", ") || "baseline metadata"}${penalties.length ? `; penalties: ${penalties.join(", ")}` : ""}`
  };
}

export function meaningfulTermsForSpec(spec: RequirementSpec): string[] {
  return normalizeTerms([...spec.capabilities.flatMap((capability) => [capability.name, ...capability.keywords]), ...spec.preferredStack]);
}

export function normalizeTerms(values: string[]): string[] {
  const generic = new Set([
    "app",
    "application",
    "build",
    "create",
    "small",
    "simple",
    "tiny",
    "minimal",
    "typescript",
    "javascript",
    "node",
    "react",
    "test",
    "tests",
    "file",
    "with",
    "and"
  ]);
  return [
    ...new Set(
      values
        .flatMap((value) => value.toLowerCase().match(/[a-z][a-z0-9+-]{1,}|[\p{Script=Han}]{2,}/gu) ?? [])
        .filter((term) => !generic.has(term))
    )
  ].slice(0, 12);
}
