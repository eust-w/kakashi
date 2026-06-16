import { Octokit } from "@octokit/rest";
import type { RequirementSpec, RepoCandidate } from "./types";
import { KakashiError } from "./errors";
import { resolveGitHubToken } from "./github-auth";
import { isAllowedLicense } from "./license-policy";
import { runCommand } from "./utils/command";
import { explainRepositoryScore, meaningfulTermsForSpec, normalizeTerms } from "./repository-score";

export interface GitHubSearchOptions {
  cwd: string;
  maxRepos: number;
  allowCopyleft: boolean;
}

export class GitHubSearcher {
  async search(spec: RequirementSpec, options: GitHubSearchOptions): Promise<RepoCandidate[]> {
    const token = await resolveGitHubToken(options.cwd);
    if (!token) {
      throw new KakashiError(
        "GITHUB_AUTH_MISSING",
        "GitHub authentication is required. Set GITHUB_TOKEN/GH_TOKEN or run `gh auth login`."
      );
    }

    let octokit = new Octokit({ auth: token });
    const queries = this.buildQueries(spec, options.maxRepos);
    const seen = new Map<string, RepoCandidate>();

    for (const query of queries) {
      const responseData = await octokit.search
        .repos({
          q: query,
          per_page: Math.min(30, Math.max(5, options.maxRepos * 4))
        })
        .then((response) => response.data)
        .catch(async (error: unknown) => {
          if (isBadCredentials(error) || isTransientNetworkError(error)) {
            const ghData = await this.searchViaGh(query, options);
            if (ghData) return ghData;
            if (isTransientNetworkError(error)) throw error;
            octokit = new Octokit();
            const response = await octokit.search.repos({
              q: query,
              per_page: Math.min(30, Math.max(5, options.maxRepos * 4))
            });
            return response.data;
          }
          if (isRateLimited(error)) {
            throw new KakashiError(
              "GITHUB_RATE_LIMITED",
              "GitHub rejected the search request because the API rate limit was reached.",
              error
            );
          }
          throw error;
        });

      for (const item of responseData.items) {
        const license = item.license?.spdx_id ?? null;
        if (item.archived || item.fork || !isAllowedLicense(license, options.allowCopyleft)) continue;

        const matchedCapabilities = spec.capabilities
          .filter((capability) => this.matchesCapability(item, capability.keywords))
          .map((capability) => capability.id);

        const score = explainRepositoryScore(item, matchedCapabilities.length, spec);
        const candidate: RepoCandidate = {
          id: item.id,
          fullName: item.full_name,
          owner: item.owner?.login ?? item.full_name.split("/")[0] ?? "",
          name: item.name,
          htmlUrl: item.html_url,
          cloneUrl: item.clone_url,
          defaultBranch: item.default_branch ?? "main",
          description: item.description ?? "",
          stars: item.stargazers_count ?? 0,
          forks: item.forks_count ?? 0,
          openIssues: item.open_issues_count ?? 0,
          sizeKb: item.size,
          language: item.language ?? null,
          license,
          updatedAt: item.updated_at ?? "",
          pushedAt: item.pushed_at ?? null,
          archived: item.archived ?? false,
          fork: item.fork ?? false,
          score: score.total,
          scoreBreakdown: score.breakdown,
          scoreReason: score.reason,
          matchedCapabilities
        };

        const existing = seen.get(candidate.fullName);
        if (!existing || candidate.score > existing.score) {
          seen.set(candidate.fullName, candidate);
        }
      }
    }

    return [...seen.values()].sort((a, b) => b.score - a.score).slice(0, options.maxRepos);
  }

  private async searchViaGh(
    query: string,
    options: GitHubSearchOptions
  ): Promise<{ items: GitHubSearchItem[] } | null> {
    try {
      const result = await runCommand(
        "gh",
        [
          "api",
          "--method",
          "GET",
          "search/repositories",
          "-f",
          `q=${query}`,
          "-f",
          `per_page=${Math.min(30, Math.max(5, options.maxRepos * 4))}`,
          "--jq",
          "{items: [.items[] | {id, full_name, name, html_url, clone_url, default_branch, description, stargazers_count, forks_count, open_issues_count, language, license, updated_at, pushed_at, archived, fork, size, owner: {login: .owner.login}}]}"
        ],
        {
          cwd: options.cwd,
          timeoutMs: 30_000
        }
      );
      if (result.exitCode !== 0) {
        if (/rate limit/i.test(`${result.stdout}\n${result.stderr}`)) {
          throw new KakashiError("GITHUB_RATE_LIMITED", "GitHub CLI reported that the Search API rate limit was reached.", result);
        }
        return null;
      }
      return JSON.parse(result.stdout) as { items: GitHubSearchItem[] };
    } catch (error) {
      if (error instanceof KakashiError) throw error;
      return null;
    }
  }

  private buildQueries(spec: RequirementSpec, maxRepos: number): string[] {
    const language = spec.preferredStack.includes("typescript")
      ? " language:TypeScript"
      : spec.preferredStack.includes("python")
        ? " language:Python"
        : spec.preferredStack.includes("go")
          ? " language:Go"
          : "";

    const target = spec.target !== "unknown" ? spec.target : "";
    const meaningfulTerms = meaningfulTermsForSpec(spec);
    const baseTerms = [...new Set([...meaningfulTerms.slice(0, 8), target, ...spec.preferredStack])].filter(Boolean).join(" ");
    const base = `${baseTerms}${language} in:name,description,readme archived:false fork:false`.trim();
    const capabilityQueries = spec.capabilities.slice(0, Math.max(2, Math.min(6, maxRepos))).map((capability) => {
      const terms = this
        .normalizeTerms([capability.name, ...capability.keywords, target, ...spec.preferredStack])
        .slice(0, 6)
        .join(" ");
      return `${terms}${language} in:name,description,readme archived:false fork:false`.trim();
    });
    return [base, ...capabilityQueries];
  }

  private matchesCapability(item: { name?: string; description?: string | null; full_name?: string }, keywords: string[]): boolean {
    const haystack = `${item.full_name ?? ""} ${item.name ?? ""} ${item.description ?? ""}`.toLowerCase();
    return keywords.some((keyword) => haystack.includes(keyword.toLowerCase()));
  }

  private normalizeTerms(values: string[]): string[] {
    return normalizeTerms(values);
  }
}

interface GitHubSearchItem {
  id: number;
  full_name: string;
  name: string;
  html_url: string;
  clone_url: string;
  default_branch?: string;
  description?: string | null;
  stargazers_count?: number;
  forks_count?: number;
  open_issues_count?: number;
  language?: string | null;
  license?: { spdx_id?: string | null } | null;
  updated_at?: string | null;
  pushed_at?: string | null;
  archived?: boolean;
  fork?: boolean;
  size?: number;
  owner?: { login?: string };
}


function isBadCredentials(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status?: number }).status === 401
  );
}

function isRateLimited(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("status" in error)) return false;
  const status = (error as { status?: number }).status;
  if (status !== 403 && status !== 429) return false;
  const message = "message" in error ? String((error as { message?: unknown }).message) : "";
  return /rate limit|secondary rate limit/i.test(message);
}

function isTransientNetworkError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message} ${(error as { cause?: unknown }).cause ?? ""}` : String(error);
  return /fetch failed|connect timeout|econnreset|etimedout|socket disconnected|network/i.test(text);
}
