import { copyFile, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { FusionPlan, RunReport, VerificationResult, CodexResult } from "./types";
import { ensureDir, pathExists, writeJsonFile } from "./utils/fs";
import { slugify } from "./utils/ids";
import { redactObject, redactSecrets } from "./utils/redaction";

export class Exporter {
  async exportReport(
    runId: string,
    plan: FusionPlan,
    verification: VerificationResult,
    codexRuns: CodexResult[],
    verificationAttempts: VerificationResult[] = [verification]
  ): Promise<RunReport> {
    const report = redactObject<RunReport>({
      runId,
      requirement: plan.requirement,
      plan,
      verification,
      verificationAttempts,
      codexRuns,
      outputDir: plan.outputDir,
      completedAt: new Date().toISOString()
    });

    const kakashiDir = join(plan.outputDir, ".kakashi");
    await ensureDir(kakashiDir);
    await writeJsonFile(join(kakashiDir, "run-report.json"), report);
    await writeJsonFile(join(plan.outputDir, "SOURCE_PROVENANCE.json"), redactObject(this.provenance(plan)));
    await this.copyLicenses(plan);
    await this.writeMarkdownReport(report);
    await this.writeReadme(report.plan, report.verification);
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
              `  - ${match.capabilityName}: 置信度 ${Math.round(match.confidence * 100)}% / ${Math.round(match.confidence * 100)}% confidence; 证据 / evidence: ${formatList(match.evidence)}`
          )
          .join("\n");
        const modules = analysis.modules
          .slice(0, 12)
          .map((module) => `  - \`${module.path}\` (${module.kind}): ${module.summary || "已检查 / inspected"}`)
          .join("\n");
        const commands = analysis.commands
          .map((command) => `  - ${command.purpose}: \`${command.command}\`，来源 / from ${command.source}`)
          .join("\n");
        return [
          `### ${analysis.candidate.fullName} (${role})`,
          "",
          `- URL: ${analysis.candidate.htmlUrl}`,
          `- Clone URL: ${analysis.candidate.cloneUrl}`,
          `- 许可证 / License: ${analysis.candidate.license ?? "unknown"}`,
          `- Stars: ${analysis.candidate.stars}; 语言 / language: ${analysis.candidate.language ?? "unknown"}; 默认分支 / default branch: ${analysis.candidate.defaultBranch}`,
          `- 选择评分 / Selection score: ${analysis.candidate.score.toFixed(2)} (${analysis.candidate.scoreReason ?? "no score explanation recorded"})`,
          `- 描述 / Description: ${analysis.candidate.description || "无描述 / No description provided."}`,
          `- 本地分析路径 / Local analysis path: \`${analysis.localPath}\``,
          `- 检测到的技术栈 / Stack detected: ${formatList(analysis.stack)}`,
          `- 检测到的包管理器 / Package managers detected: ${formatList(analysis.packageManagers)}`,
          `- 已检查 manifests / Manifests inspected: ${formatList(analysis.manifests)}`,
          "",
          `能力匹配 / Capability matches:`,
          capabilityMatches || "  - 无 / none",
          "",
          `检测到的命令 / Commands detected:`,
          commands || "  - 无 / none",
          "",
          `已检查并提供给 Codex 参考的源码区域 / Source areas inspected and prepared for Codex reference:`,
          modules || "  - 未检测到常见源码目录 / no common source roots detected",
          "",
          `README 摘要 / README summary: ${analysis.readmeSummary || "无 README 摘要 / No README summary available."}`,
          "",
          `风险 / Risks: ${formatList(analysis.risks)}`
        ].join("\n");
      })
      .join("\n\n");

    const selectedSources = [report.plan.main, ...report.plan.auxiliaries]
      .map((source) => {
        const capabilities = source.providedCapabilities.map((id) => capabilityNames.get(id) ?? id);
        return [
          `### ${source.role}: ${source.repo.fullName}`,
          "",
          `- 融合用途 / Purpose in fusion: ${source.rationale}`,
          `- 使用的能力 / Capabilities used: ${formatList(capabilities)}`,
          `- Codex 使用的源码 checkout / Source checkout used by Codex: \`${source.localPath}\``
        ].join("\n");
      })
      .join("\n\n");

    const capabilityGraph = report.plan.graph.capabilities
      .map((capability) => {
        const providers = report.plan.graph.edges
          .filter((edge) => edge.capabilityId === capability.id)
          .map((edge) => `${edge.repoFullName} (${Math.round(edge.confidence * 100)}%, 证据 / evidence: ${formatList(edge.evidence)})`);
        return `- ${capability.name}: ${providers.length > 0 ? providers.join("; ") : "检测到缺口 / gap detected"}`;
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
        return [`### 验证尝试 ${index + 1} / Verification Attempt ${index + 1}`, "", attempt.summary, "", steps || "  - 未执行验证步骤 / No verification steps executed."].join("\n");
      })
      .join("\n\n");

    const codexIterations = report.codexRuns
      .map((run, index) => {
        const parsed = parseCodexFinalMessage(run.finalMessage);
        return [
          `### Codex 迭代 ${index + 1} / Codex Iteration ${index + 1}`,
          "",
          `- 退出码 / Exit code: ${run.exitCode}`,
          `- 命令 / Command: \`${run.result.command}\``,
          `- 耗时 / Duration: ${run.result.durationMs}ms`,
          parsed
            ? [
                `- 摘要 / Summary: ${parsed.summary}`,
                `- 修改文件 / Changed files: ${formatList(parsed.changedFiles)}`,
                `- 验证说明 / Verification notes: ${parsed.verificationNotes}`,
                `- 阻塞项 / Blockers: ${formatList(parsed.blockers)}`
              ].join("\n")
            : `最终消息 / Final message:\n\n${run.finalMessage}`
        ].join("\n");
      })
      .join("\n\n");

    const loopSummary =
      report.codexRuns.length > 1 || report.verificationAttempts.length > 1
        ? `是。Kakashi 执行了 ${report.codexRuns.length} 次 Codex 迭代和 ${report.verificationAttempts.length} 次 verifier 尝试。\n\nEnglish: Yes. Kakashi ran ${report.codexRuns.length} Codex iteration(s) and ${report.verificationAttempts.length} verifier attempt(s).`
        : `无需修复回环。Kakashi 执行了 ${report.codexRuns.length} 次 Codex 迭代和 ${report.verificationAttempts.length} 次 verifier 尝试。\n\nEnglish: No repair loop was needed. Kakashi ran ${report.codexRuns.length} Codex iteration(s) and ${report.verificationAttempts.length} verifier attempt(s).`;

    const content = [
      `# Kakashi 完整流程报告 / Full Process Report`,
      "",
      `运行 ID / Run: \`${report.runId}\``,
      `完成时间 / Completed: ${report.completedAt}`,
      `输出目录 / Output directory: \`${report.outputDir}\``,
      "",
      `## 需求 / Requirement`,
      "",
      report.requirement.raw,
      "",
      `- 目标 / Target: ${report.requirement.target}`,
      `- 偏好技术栈 / Preferred stack: ${formatList(report.requirement.preferredStack)}`,
      `- 约束 / Constraints: ${formatList(report.requirement.constraints)}`,
      `- 解析出的能力 / Parsed capabilities: ${formatList(report.requirement.capabilities.map((capability) => capability.name))}`,
      "",
      `## 已分析的 GitHub 项目 / GitHub Projects Analyzed`,
      "",
      `Kakashi 分析了 ${report.plan.graph.repos.length} 个真实 GitHub 仓库候选项。`,
      "",
      `English: Kakashi analyzed ${report.plan.graph.repos.length} real GitHub repository candidate(s).`,
      "",
      analyzedRepos || "未分析仓库。 / No repositories were analyzed.",
      "",
      `## 能力图谱 / Capability Graph`,
      "",
      capabilityGraph || "未生成能力图谱边。 / No capability graph edges were produced.",
      "",
      `未解决缺口 / Unresolved gaps: ${formatList(report.plan.graph.gaps.map((capability) => capability.name))}`,
      "",
      `## 选中的融合来源 / Selected Fusion Sources`,
      "",
      selectedSources || "未记录选中的来源。 / No selected sources were recorded.",
      "",
      `## 融合目标和任务 / Fusion Goal and Tasks`,
      "",
      `最终目标 / Final target: ${report.requirement.goal}`,
      "",
      tasks || "未生成 Codex 任务。 / No Codex tasks were generated.",
      "",
      `## 能力采集范围 / Capability Collection Scope`,
      "",
      "Kakashi 会把选中的源码仓库 checkout 和上面列出的已检查源码区域提供给 Codex。具体来自源码的改动体现在 Codex 迭代输出和最终项目 diff 中；除非某个仓库被选为主来源或辅助来源，否则 Kakashi 不会把它报告为已采集模块。",
      "",
      "English: Kakashi provided Codex with the selected source repository checkouts and the inspected source areas listed above. Exact source-derived edits are reflected in Codex iteration output and the final project diff; Kakashi does not report a module as collected unless it was selected as a main or auxiliary source.",
      "",
      `## Codex 执行 / Codex Execution`,
      "",
      codexIterations || "未记录 Codex 执行。 / No Codex execution was recorded.",
      "",
      `## 验证和修复回环 / Verification and Repair Loop`,
      "",
      loopSummary,
      "",
      report.verification.summary,
      "",
      verificationAttempts || "- 未记录验证尝试。 / No verification attempts were recorded.",
      "",
      `## 导出产物 / Exported Artifacts`,
      "",
      "- `README.md`: 生成项目的使用说明和 Kakashi 摘要。 / Generated project usage notes plus Kakashi summary.",
      "- `KAKASHI_REPORT.md`: 当前这份人类可读的完整流程报告。 / This human-readable full process report.",
      "- `SOURCE_PROVENANCE.json`: 源仓库来源和选中能力元数据。 / Source repository provenance and selected capability metadata.",
      "- `.kakashi/run-report.json`: 机器可读的运行状态、图谱、Codex 结果和 verifier 结果。 / Machine-readable run state, graph, Codex results, and verifier results.",
      "- `.kakashi/licenses/`: 选中源仓库的许可证文件副本。 / Copied license files from selected source repositories when present."
    ].join("\n");
    await writeFileSafe(join(report.outputDir, "KAKASHI_REPORT.md"), content);
  }

  private async writeReadme(plan: FusionPlan, verification: VerificationResult): Promise<void> {
    const readmePath = join(plan.outputDir, "README.md");
    const section = [
      "",
      "## Kakashi 融合说明 / Kakashi Fusion",
      "",
      `本项目由 Kakashi 基于以下需求生成：${plan.requirement.raw}`,
      "",
      `English: This project was produced by Kakashi from requirement: ${plan.requirement.raw}`,
      "",
      "### 来源追踪 / Source Provenance",
      "",
      `源仓库元数据和许可证文件见 \`SOURCE_PROVENANCE.json\` 与 \`.kakashi/licenses/\`。`,
      "",
      `English: See \`SOURCE_PROVENANCE.json\` and \`.kakashi/licenses/\` for source repository metadata and license files.`,
      "",
      "### 验证 / Verification",
      "",
      verification.summary,
      "",
      ...verification.steps.map((step) => `- ${step.ok ? "PASS" : "FAIL"} \`${step.command}\``),
      ""
    ].join("\n");

    if (await pathExists(readmePath)) {
      const existing = await readFile(readmePath, "utf8");
      if (!existing.includes("## Kakashi 融合说明 / Kakashi Fusion") && !existing.includes("## Kakashi Fusion")) {
        await writeFileSafe(readmePath, `${existing.trimEnd()}\n${section}`);
      }
      return;
    }
    await writeFileSafe(readmePath, `# 融合项目 / Fused Project\n${section}`);
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
  await writeFile(path, `${redactSecrets(content).trimEnd()}\n`, "utf8");
}
