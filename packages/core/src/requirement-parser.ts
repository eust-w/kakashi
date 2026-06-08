import type { Capability, RequirementSpec } from "./types";
import { stableId } from "./utils/ids";

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "app",
  "application",
  "build",
  "create",
  "for",
  "from",
  "i",
  "need",
  "of",
  "please",
  "software",
  "small",
  "simple",
  "tiny",
  "minimal",
  "that",
  "test",
  "tests",
  "the",
  "to",
  "typescript",
  "javascript",
  "node",
  "react",
  "vue",
  "svelte",
  "with",
  "want",
  "一个",
  "可以",
  "支持",
  "需要",
  "软件",
  "项目",
  "系统",
  "应用",
  "帮我",
  "实现",
  "生成"
]);

const TARGET_KEYWORDS: Array<[RequirementSpec["target"], RegExp]> = [
  ["web", /\b(web|website|dashboard|browser|frontend|react|next|vue)\b|网页|网站|前端|仪表盘/i],
  ["cli", /\b(cli|terminal|command line|shell)\b|命令行|终端/i],
  ["api", /\b(api|backend|server|service|rest|graphql)\b|后端|接口|服务/i],
  ["desktop", /\b(desktop|electron|macos|windows|linux app)\b|桌面/i],
  ["mobile", /\b(mobile|ios|android|react native|flutter)\b|手机|移动端/i],
  ["library", /\b(library|sdk|package|module)\b|库|SDK/i]
];

const STACK_KEYWORDS: Array<[string, RegExp]> = [
  ["react", /\breact\b/i],
  ["nextjs", /\bnext(?:\.js)?\b/i],
  ["vue", /\bvue\b/i],
  ["svelte", /\bsvelte\b/i],
  ["node", /\bnode(?:\.js)?\b/i],
  ["typescript", /\btypescript|ts\b/i],
  ["python", /\bpython|django|flask|fastapi\b/i],
  ["go", /\bgolang|go\b/i],
  ["rust", /\brust\b/i],
  ["electron", /\belectron\b/i]
];

export class RequirementParser {
  parse(input: string): RequirementSpec {
    const raw = input.trim();
    if (!raw) {
      throw new Error("Requirement cannot be empty.");
    }

    const target = this.detectTarget(raw);
    const preferredStack = STACK_KEYWORDS.filter(([, pattern]) => pattern.test(raw)).map(([name]) => name);
    const capabilities = this.extractCapabilities(raw);
    const constraints = this.extractConstraints(raw);

    return {
      raw,
      goal: raw.replace(/\s+/g, " "),
      target,
      preferredStack,
      capabilities,
      constraints
    };
  }

  private detectTarget(input: string): RequirementSpec["target"] {
    for (const [target, pattern] of TARGET_KEYWORDS) {
      if (pattern.test(input)) return target;
    }
    return "unknown";
  }

  private extractCapabilities(input: string): Capability[] {
    const normalized = input.replace(/[，。；;、\n]+/g, ",");
    const explicit = normalized
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length >= 2)
      .flatMap((part) => this.extractCapabilityPhrases(part));

    const keywordFallback = this.extractKeywords(input);
    const names = [...explicit, ...keywordFallback]
      .map((name) => name.trim())
      .filter(Boolean)
      .filter((name) => !STOP_WORDS.has(name.toLowerCase()));

    const unique = new Map<string, Capability>();
    for (const name of names) {
      const key = name.toLowerCase();
      if (unique.has(key)) continue;
      const keywords = this.extractKeywords(name);
      unique.set(key, {
        id: stableId(key),
        name,
        description: `Provide capability: ${name}`,
        keywords: keywords.length > 0 ? keywords : [name],
        required: true
      });
    }

    if (unique.size === 0) {
      unique.set(stableId(input), {
        id: stableId(input),
        name: input,
        description: `Provide capability: ${input}`,
        keywords: this.extractKeywords(input),
        required: true
      });
    }

    return [...unique.values()].slice(0, 12);
  }

  private extractCapabilityPhrases(part: string): string[] {
    const matches = [
      ...part.matchAll(/\b(?:with|including|include|supports?|needs?)\s+([^,.]+)/gi),
      ...part.matchAll(/(?:支持|包含|包括|需要|具备|带有)([^,.，。；;]+)/g)
    ].map((match) => match[1]?.trim()).filter((value): value is string => Boolean(value));

    if (matches.length > 0) return matches;

    const words = this.extractKeywords(part);
    if (words.length <= 3) return words;
    return [words.slice(0, 5).join(" ")];
  }

  private extractKeywords(input: string): string[] {
    const ascii = input
      .toLowerCase()
      .match(/[a-z][a-z0-9+-]{1,}/g)
      ?.filter((word) => !STOP_WORDS.has(word)) ?? [];

    const cjk = input
      .match(/[\p{Script=Han}]{2,}/gu)
      ?.map((word) => word.trim())
      .filter((word) => !STOP_WORDS.has(word)) ?? [];

    return [...new Set([...ascii, ...cjk])].slice(0, 16);
  }

  private extractConstraints(input: string): string[] {
    const constraints: string[] = [];
    if (/no\s+(?:mock|fake|simulation|hardcode)|不要(?:mock|仿真|模拟|硬编码)|不(?:要)?硬编码/i.test(input)) {
      constraints.push("no mock, fake, simulated, or hardcoded success paths");
    }
    if (/open\s*source|开源/i.test(input)) constraints.push("use open-source sources");
    if (/local|本地/i.test(input)) constraints.push("must run locally");
    return constraints;
  }
}
