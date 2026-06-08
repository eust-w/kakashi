import type { Capability } from "./types";
import { stableId } from "./utils/ids";

const MISSING_PATTERNS = [
  /Cannot find module ['"]([^'"]+)['"]/gi,
  /Module not found:.*?['"]([^'"]+)['"]/gi,
  /command not found:?\s+([A-Za-z0-9_.-]+)/gi,
  /No module named ['"]?([A-Za-z0-9_.-]+)['"]?/gi,
  /missing capability:?\s+([^\n]+)/gi
];

export class GapDetector {
  detect(logs: string, existing: Capability[]): Capability[] {
    const known = new Set(existing.map((capability) => capability.name.toLowerCase()));
    const gaps: Capability[] = [];

    for (const pattern of MISSING_PATTERNS) {
      for (const match of logs.matchAll(pattern)) {
        const name = match[1]?.trim();
        if (!name || known.has(name.toLowerCase())) continue;
        known.add(name.toLowerCase());
        gaps.push({
          id: stableId(`gap:${name}`),
          name,
          description: `Detected missing dependency or capability from verification logs: ${name}`,
          keywords: name.split(/[^A-Za-z0-9_.-]+/).filter(Boolean),
          required: true
        });
      }
    }

    return gaps.slice(0, 5);
  }
}

