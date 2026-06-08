import { runCommand } from "./utils/command";

export async function resolveGitHubToken(cwd: string): Promise<string | null> {
  const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (fromEnv?.trim()) return fromEnv.trim();

  try {
    const result = await runCommand("gh", ["auth", "token"], {
      cwd,
      timeoutMs: 10_000
    });
    if (result.exitCode === 0 && result.stdout.trim()) {
      return result.stdout.trim();
    }
  } catch {
    return null;
  }

  return null;
}

