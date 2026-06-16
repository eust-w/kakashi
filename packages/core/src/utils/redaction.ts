const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/gh[pousr]_[A-Za-z0-9_]{20,}/g, "[REDACTED]"],
  [/github_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED]"],
  [/sk-[A-Za-z0-9_-]{20,}/g, "[REDACTED]"],
  [
    /((?:"|')?[A-Za-z0-9_.-]*(?:api[_-]?key|access[_-]?token|token|secret|password)(?:"|')?\s*[:=]\s*)(["']?)([^\s,"'}\\]+)/gi,
    "$1$2[REDACTED]"
  ],
  [/(Authorization:\s*(?:Bearer|Token)\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]"]
];

export function redactSecrets(input: string): string {
  return SECRET_PATTERNS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), input);
}

export function redactObject<T>(value: T): T {
  return JSON.parse(redactSecrets(JSON.stringify(value))) as T;
}
