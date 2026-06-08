import { Octokit } from "@octokit/rest";
import type { RequirementSpec, RepoCandidate } from "./types";
import { KakashiError } from "./errors";
import { resolveGitHubToken } from "./github-auth";
import { isAllowedLicense } from "./license-policy";
import { runCommand } from "./utils/command";

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
          if (isBadCredentials(error)) {
            const ghData = await this.searchViaGh(query, options);
            if (ghData) return ghData;
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
          score: this.scoreCandidate(item, matchedCapabilities.length, spec),
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
    const meaningfulTerms = this.meaningfulTerms(spec);
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

  private scoreCandidate(
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
  ): number {
    const stars = Math.log10((item.stargazers_count ?? 0) + 1) * 5;
    const forks = Math.log10((item.forks_count ?? 0) + 1);
    const freshness = item.pushed_at
      ? Math.max(0, 12 - (Date.now() - Date.parse(item.pushed_at)) / (1000 * 60 * 60 * 24 * 60))
      : 0;
    const nameDescription = `${item.full_name ?? ""} ${item.name ?? ""} ${item.description ?? ""}`.toLowerCase();
    const terms = this.meaningfulTerms(spec);
    const directTermHits = terms.filter((term) => nameDescription.includes(term)).length;
    const targetBoost =
      spec.target === "unknown" || nameDescription.includes(spec.target)
        ? 5
        : spec.target === "cli" && /\b(cli|command|terminal|shell)\b/i.test(nameDescription)
          ? 8
          : 0;
    const stackBoost = spec.preferredStack.some((stack) => item.language?.toLowerCase().includes(stack)) ? 5 : 0;
    const sizePenalty = Math.log10((item.size ?? 0) + 1) * 3.5;
    const issuePenalty = Math.log10((item.open_issues_count ?? 0) + 1);
    return stars + forks + freshness + matchedCapabilityCount * 5 + directTermHits * 12 + targetBoost + stackBoost - issuePenalty - sizePenalty;
  }

  private meaningfulTerms(spec: RequirementSpec): string[] {
    return this.normalizeTerms([
      ...spec.capabilities.flatMap((capability) => [capability.name, ...capability.keywords]),
      ...spec.preferredStack
    ]);
  }

  private normalizeTerms(values: string[]): string[] {
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
