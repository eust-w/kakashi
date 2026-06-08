import { createHash, randomUUID } from "node:crypto";

export function createRunId(): string {
  const now = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `run_${now}_${randomUUID().slice(0, 8)}`;
}

export function stableId(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 12);
}

export function slugify(input: string): string {
  const cleaned = input
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return cleaned || stableId(input);
}

