import type { CommandResult } from "./types";
import { resolveGitHubToken } from "./github-auth";
import { findExecutable, runCommand } from "./utils/command";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  result?: CommandResult;
}

export class Doctor {
  async run(cwd: string): Promise<DoctorCheck[]> {
    const checks: DoctorCheck[] = [];
    for (const command of ["git", "gh", "codex", "node", "pnpm"]) {
      const path = await findExecutable(command);
      checks.push({
        name: command,
        ok: Boolean(path),
        detail: path ?? `${command} was not found on PATH.`
      });
    }

    const token = await resolveGitHubToken(cwd);
    checks.push({
      name: "github-auth",
      ok: Boolean(token),
      detail: token ? "GitHub token resolved from environment or gh auth." : "Run `gh auth login` or set GITHUB_TOKEN/GH_TOKEN."
    });

    for (const command of ["codex", "gh", "git"]) {
      if (!(await findExecutable(command))) continue;
      const result = await runCommand(command, command === "codex" ? ["--version"] : ["--version"], {
        cwd,
        timeoutMs: 10_000
      });
      checks.push({
        name: `${command}-version`,
        ok: result.exitCode === 0,
        detail: result.stdout.trim() || result.stderr.trim(),
        result
      });
    }

    return checks;
  }
}

