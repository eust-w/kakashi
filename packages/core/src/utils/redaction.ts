const SECRET_PATTERNS: RegExp[] = [
  /gh[pousr]_[A-Za-z0-9_]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /(?:api[_-]?key|token|secret|password)=([^\s'"]+)/gi,
  /Authorization:\s*Bearer\s+[A-Za-z0-9._-]+/gi
];

export function redactSecrets(input: string): string {
  return SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, "[REDACTED]"), input);
}

export function redactObject<T>(value: T): T {
  return JSON.parse(redactSecrets(JSON.stringify(value))) as T;
}

