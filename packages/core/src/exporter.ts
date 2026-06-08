import { copyFile, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { FusionPlan, RunReport, VerificationResult, CodexResult } from "./types";
import { ensureDir, pathExists, writeJsonFile } from "./utils/fs";
import { slugify } from "./utils/ids";

export class Exporter {
  async exportReport(
    runId: string,
    plan: FusionPlan,
    verification: VerificationResult,
    codexRuns: CodexResult[],
    verificationAttempts: VerificationResult[] = [verification]
  ): Promise<RunReport> {
    const report: RunReport = {
      runId,
      requirement: plan.requirement,
      plan,
      verification,
      verificationAttempts,
      codexRuns,
      outputDir: plan.outputDir,
      completedAt: new Date().toISOString()
    };

    const kakashiDir = join(plan.outputDir, ".kakashi");
    await ensureDir(kakashiDir);
    await writeJsonFile(join(kakashiDir, "run-report.json"), report);
    await writeJsonFile(join(plan.outputDir, "SOURCE_PROVENANCE.json"), this.provenance(plan));
    await this.copyLicenses(plan);
    await this.writeMarkdownReport(report);
    await this.writeReadme(plan, verification);
    return report;
  }

  private provenance(plan: FusionPlan): unknown {
    return {
      generatedAt: new Date().toISOString(),
      requirement: plan.requirement.raw,
      sources: [plan.main, ...plan.auxiliaries].map((source) => ({
        role: source.role,
        fullName: source.repo.fullName,
        url: source.repo.htmlUrl,
        cloneUrl: source.repo.cloneUrl,
        license: source.repo.license,
        providedCapabilities: source.providedCapabilities,
        rationale: source.rationale
      }))
    };
  }

  private async copyLicenses(plan: FusionPlan): Promise<void> {
    const licenseDir = join(plan.outputDir, ".kakashi", "licenses");
    await ensureDir(licenseDir);
    for (const source of [plan.main, ...plan.auxiliaries]) {
      for (const name of ["LICENSE", "LICENSE.md", "COPYING", "NOTICE"]) {
        const src = join(source.localPath, name);
        if (await pathExists(src)) {
          await copyFile(src, join(licenseDir, `${slugify(source.repo.fullName)}-${basename(name)}`));
          break;
        }
      }
    }
  }

  private async writeMarkdownReport(report: RunReport): Promise<void> {
    const selectedNames = new Map([
      [report.plan.main.repo.fullName, "main"],
      ...report.plan.auxiliaries.map((source) => [source.repo.fullName, "auxiliary"] as const)
    ]);
    const capabilityNames = new Map(report.plan.graph.capabilities.map((capability) => [capability.id, capability.name]));
    const analyzedRepos = report.plan.graph.repos
      .map((analysis) => {
        const role = selectedNames.get(analysis.candidate.fullName) ?? "analyzed-only";
        const capabilityMatches = analysis.capabilityMatches
          .map(
            (match) =>
              `  - ${match.capabilityName}: ${Math.round(match.confidence * 100)}% confidence; evidence: ${formatList(match.evidence)}`
          )
          .join("\n");
        const modules = analysis.modules
          .slice(0, 12)
          .map((module) => `  - \`${module.path}\` (${module.kind}): ${module.summary || "inspected"}`)
          .join("\n");
        const commands = analysis.commands
          .map((command) => `  - ${command.purpose}: \`${command.command}\` from ${command.source}`)
          .join("\n");
        return [
          `### ${analysis.candidate.fullName} (${role})`,
          "",
          `- URL: ${analysis.candidate.htmlUrl}`,
          `- Clone URL: ${analysis.candidate.cloneUrl}`,
          `- License: ${analysis.candidate.license ?? "unknown"}`,
          `- Stars: ${analysis.candidate.stars}; language: ${analysis.candidate.language ?? "unknown"}; default branch: ${analysis.candidate.defaultBranch}`,
          `- Description: ${analysis.candidate.description || "No description provided."}`,
          `- Local analysis path: \`${analysis.localPath}\``,
          `- Stack detected: ${formatList(analysis.stack)}`,
          `- Package managers detected: ${formatList(analysis.packageManagers)}`,
          `- Manifests inspected: ${formatList(analysis.manifests)}`,
          "",
          `Capability matches:`,
          capabilityMatches || "  - none",
          "",
          `Commands detected:`,
          commands || "  - none",
          "",
          `Source areas inspected / prepared for Codex reference:`,
          modules || "  - no common source roots detected",
          "",
          `README summary: ${analysis.readmeSummary || "No README summary available."}`,
          "",
          `Risks: ${formatList(analysis.risks)}`
        ].join("\n");
      })
      .join("\n\n");

    const selectedSources = [report.plan.main, ...report.plan.auxiliaries]
      .map((source) => {
        const capabilities = source.providedCapabilities.map((id) => capabilityNames.get(id) ?? id);
        return [
          `### ${source.role}: ${source.repo.fullName}`,
          "",
          `- Purpose in fusion: ${source.rationale}`,
          `- Capabilities used: ${formatList(capabilities)}`,
          `- Source checkout used by Codex: \`${source.localPath}\``
        ].join("\n");
      })
      .join("\n\n");

    const capabilityGraph = report.plan.graph.capabilities
      .map((capability) => {
        const providers = report.plan.graph.edges
          .filter((edge) => edge.capabilityId === capability.id)
          .map((edge) => `${edge.repoFullName} (${Math.round(edge.confidence * 100)}%, evidence: ${formatList(edge.evidence)})`);
        return `- ${capability.name}: ${providers.length > 0 ? providers.join("; ") : "gap detected"}`;
      })
      .join("\n");

    const tasks = report.plan.tasks
      .map((task, index) => {
        const criteria = task.successCriteria.map((criterion) => `  - ${criterion}`).join("\n");
        return `${index + 1}. ${task.title}\n${criteria}`;
      })
      .join("\n");

    const verificationAttempts = report.verificationAttempts
      .map((attempt, index) => {
        const steps = attempt.steps
          .map(
            (step) =>
              `  - ${step.ok ? "PASS" : "FAIL"} ${step.name}: \`${step.command}\` (exit ${step.result.exitCode ?? "signal"}, ${step.result.durationMs}ms)`
          )
          .join("\n");
        return [`### Verification Attempt ${index + 1}`, "", attempt.summary, "", steps || "  - No verification steps executed."].join("\n");
      })
      .join("\n\n");

    const codexIterations = report.codexRuns
      .map((run, index) => {
        const parsed = parseCodexFinalMessage(run.finalMessage);
        return [
          `### Codex Iteration ${index + 1}`,
          "",
          `- Exit code: ${run.exitCode}`,
          `- Command: \`${run.result.command}\``,
          `- Duration: ${run.result.durationMs}ms`,
          parsed
            ? [
                `- Summary: ${parsed.summary}`,
                `- Changed files: ${formatList(parsed.changedFiles)}`,
                `- Verification notes: ${parsed.verificationNotes}`,
                `- Blockers: ${formatList(parsed.blockers)}`
              ].join("\n")
            : `Final message:\n\n${run.finalMessage}`
        ].join("\n");
      })
      .join("\n\n");

    const loopSummary =
      report.codexRuns.length > 1 || report.verificationAttempts.length > 1
        ? `Yes. Kakashi ran ${report.codexRuns.length} Codex iteration(s) and ${report.verificationAttempts.length} verifier attempt(s).`
        : `No repair loop was needed. Kakashi ran ${report.codexRuns.length} Codex iteration(s) and ${report.verificationAttempts.length} verifier attempt(s).`;

    const content = [
      `# Kakashi Full Process Report`,
      "",
      `Run: \`${report.runId}\``,
      `Completed: ${report.completedAt}`,
      `Output directory: \`${report.outputDir}\``,
      "",
      `## Requirement`,
      "",
      report.requirement.raw,
      "",
      `- Target: ${report.requirement.target}`,
      `- Preferred stack: ${formatList(report.requirement.preferredStack)}`,
      `- Constraints: ${formatList(report.requirement.constraints)}`,
      `- Parsed capabilities: ${formatList(report.requirement.capabilities.map((capability) => capability.name))}`,
      "",
      `## GitHub Projects Analyzed`,
      "",
      `Kakashi analyzed ${report.plan.graph.repos.length} real GitHub repository candidate(s).`,
      "",
      analyzedRepos || "No repositories were analyzed.",
      "",
      `## Capability Graph`,
      "",
      capabilityGraph || "No capability graph edges were produced.",
      "",
      `Unresolved gaps: ${formatList(report.plan.graph.gaps.map((capability) => capability.name))}`,
      "",
      `## Selected Fusion Sources`,
      "",
      selectedSources || "No selected sources were recorded.",
      "",
      `## Fusion Goal and Tasks`,
      "",
      `Final target: ${report.requirement.goal}`,
      "",
      tasks || "No Codex tasks were generated.",
      "",
      `## Capability Collection Scope`,
      "",
      "Kakashi provided Codex with the selected source repository checkouts and the inspected source areas listed above. Exact source-derived edits are reflected in Codex iteration output and the final project diff; Kakashi does not report a module as collected unless it was selected as a main or auxiliary source.",
      "",
      `## Codex Execution`,
      "",
      codexIterations || "No Codex execution was recorded.",
      "",
      `## Verification and Repair Loop`,
      "",
      loopSummary,
      "",
      report.verification.summary,
      "",
      verificationAttempts || "- No verification attempts were recorded.",
      "",
      `## Exported Artifacts`,
      "",
      "- `README.md`: generated project usage notes plus Kakashi summary.",
      "- `KAKASHI_REPORT.md`: this human-readable full process report.",
      "- `SOURCE_PROVENANCE.json`: source repository provenance and selected capability metadata.",
      "- `.kakashi/run-report.json`: machine-readable run state, graph, Codex results, and verifier results.",
      "- `.kakashi/licenses/`: copied license files from selected source repositories when present."
    ].join("\n");
    await writeFileSafe(join(report.outputDir, "KAKASHI_REPORT.md"), content);
  }

  private async writeReadme(plan: FusionPlan, verification: VerificationResult): Promise<void> {
    const readmePath = join(plan.outputDir, "README.md");
    const section = [
      "",
      "## Kakashi Fusion",
      "",
      `This project was produced by Kakashi from requirement: ${plan.requirement.raw}`,
      "",
      "### Source Provenance",
      "",
      `See \`SOURCE_PROVENANCE.json\` and \`.kakashi/licenses/\` for source repository metadata and license files.`,
      "",
      "### Verification",
      "",
      verification.summary,
      "",
      ...verification.steps.map((step) => `- ${step.ok ? "PASS" : "FAIL"} \`${step.command}\``),
      ""
    ].join("\n");

    if (await pathExists(readmePath)) {
      const existing = await readFile(readmePath, "utf8");
      if (!existing.includes("## Kakashi Fusion")) {
        await writeFileSafe(readmePath, `${existing.trimEnd()}\n${section}`);
      }
      return;
    }
    await writeFileSafe(readmePath, `# Fused Project\n${section}`);
  }
}

interface ParsedCodexMessage {
  summary: string;
  changedFiles: string[];
  verificationNotes: string;
  blockers: string[];
}

function parseCodexFinalMessage(message: string): ParsedCodexMessage | null {
  try {
    const parsed = JSON.parse(message) as Partial<ParsedCodexMessage>;
    if (!parsed.summary || !Array.isArray(parsed.changedFiles)) return null;
    return {
      summary: parsed.summary,
      changedFiles: parsed.changedFiles,
      verificationNotes: parsed.verificationNotes ?? "",
      blockers: Array.isArray(parsed.blockers) ? parsed.blockers : []
    };
  } catch {
    return null;
  }
}

function formatList(values: Array<string | null | undefined>): string {
  const filtered = values.filter((value): value is string => Boolean(value?.trim()));
  return filtered.length > 0 ? filtered.join(", ") : "none";
}

async function writeFileSafe(path: string, content: string): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, `${content.trimEnd()}\n`, "utf8");
}
