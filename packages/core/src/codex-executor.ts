import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CodexResult, FusionPlan } from "./types";
import { ensureDir, pathExists } from "./utils/fs";
import { runCommand } from "./utils/command";

export interface CodexExecutionOptions {
  cwd: string;
  timeoutMs: number;
  model?: string;
  onEvent?: (event: unknown) => void;
  onText?: (text: string) => void;
}

export class CodexExecutor {
  async execute(plan: FusionPlan, instruction: string, options: CodexExecutionOptions): Promise<CodexResult> {
    const kakashiDir = join(options.cwd, ".kakashi");
    await ensureDir(kakashiDir);
    const schemaPath = join(kakashiDir, "codex-output.schema.json");
    const lastMessagePath = join(kakashiDir, `codex-last-${Date.now()}.json`);
    await writeFile(schemaPath, `${JSON.stringify(CODEX_OUTPUT_SCHEMA, null, 2)}\n`, "utf8");

    const args = [
      "--sandbox",
      "workspace-write",
      "-a",
      "never",
    ];
    if (options.model) args.push("-m", options.model);
    args.push(
      "exec",
      "--json",
      "-C",
      options.cwd,
      "--output-schema",
      schemaPath,
      "--output-last-message",
      lastMessagePath
    );
    args.push("-");

    const prompt = this.buildPrompt(plan, instruction);
    const events: unknown[] = [];
    let stdoutBuffer = "";

    const result = await runCommand("codex", args, {
      cwd: options.cwd,
      input: prompt,
      timeoutMs: options.timeoutMs,
      onStdout: (chunk) => {
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line) as unknown;
            events.push(event);
            options.onEvent?.(event);
          } catch {
            options.onText?.(line);
          }
        }
      },
      onStderr: (chunk) => options.onText?.(chunk)
    });

    const finalMessage = (await pathExists(lastMessagePath)) ? await readFile(lastMessagePath, "utf8") : result.stdout.slice(-4_000);
    return {
      ok: result.exitCode === 0,
      exitCode: result.exitCode,
      finalMessage,
      events,
      result
    };
  }

  private buildPrompt(plan: FusionPlan, instruction: string): string {
    const sourceList = [plan.main, ...plan.auxiliaries]
      .map((source) => `- ${source.role}: ${source.repo.fullName} (${source.localPath}) provides ${source.providedCapabilities.join(", ")}`)
      .join("\n");
    const taskList = plan.tasks.map((task, index) => `${index + 1}. ${task.title}\n${task.prompt}`).join("\n\n");

    return [
      "You are Codex executing a Kakashi repository fusion plan.",
      "Work only in the current target project. Use source repositories under .kakashi/sources as read-only references unless copying code with proper attribution.",
      "Do not introduce fake data, simulated success paths, placeholder integrations, or hardcoded verification success.",
      "Preserve license provenance and document source-derived code.",
      "",
      `User requirement: ${plan.requirement.raw}`,
      "",
      "Sources:",
      sourceList,
      "",
      "Fusion tasks:",
      taskList,
      "",
      "Specific instruction for this iteration:",
      instruction,
      "",
      "Return JSON matching the provided schema with summary, changedFiles, verificationNotes, and blockers."
    ].join("\n");
  }
}

const CODEX_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    changedFiles: { type: "array", items: { type: "string" } },
    verificationNotes: { type: "string" },
    blockers: { type: "array", items: { type: "string" } }
  },
  required: ["summary", "changedFiles", "verificationNotes", "blockers"]
};
