#!/usr/bin/env node
import { Command } from "commander";
import { resolve } from "node:path";
import pc from "picocolors";
import { checkbox, confirm } from "@inquirer/prompts";
import {
  CapabilityGraphBuilder,
  Doctor,
  FusionPlanner,
  KakashiOrchestrator,
  type KakashiOptions,
  type RunEvent
} from "@kakashi/core";

const program = new Command();

program
  .name("kakashi")
  .description("GitHub multi-repository capability fusion orchestrator for Codex CLI/Desktop.")
  .version("0.1.0");

program
  .command("doctor")
  .description("Check local Kakashi prerequisites.")
  .action(async () => {
    const checks = await new Doctor().run(process.cwd());
    for (const check of checks) {
      console.log(`${check.ok ? pc.green("PASS") : pc.red("FAIL")} ${check.name}: ${check.detail}`);
    }
    if (checks.some((check) => !check.ok)) process.exitCode = 1;
  });

program
  .command("run")
  .description("Run Kakashi in full-auto mode.")
  .argument("<requirement>", "One-sentence software requirement.")
  .requiredOption("--out <dir>", "Output project directory.")
  .option("--max-repos <number>", "Maximum GitHub repositories to analyze.", "12")
  .option("--max-iterations <number>", "Maximum Codex repair iterations.", "3")
  .option("--allow-copyleft", "Allow copyleft-licensed repositories.")
  .option("--force", "Clear the output directory before materializing the main repo.")
  .option("--model <model>", "Codex model override.")
  .action(async (requirement: string, options: CliOptions) => {
    const orchestrator = createOrchestrator(options);
    const state = await orchestrator.run(requirement, "auto");
    printFinalState(state);
  });

program
  .command("interactive")
  .description("Run Kakashi with candidate review and plan confirmation.")
  .argument("<requirement>", "One-sentence software requirement.")
  .requiredOption("--out <dir>", "Output project directory.")
  .option("--max-repos <number>", "Maximum GitHub repositories to analyze.", "12")
  .option("--max-iterations <number>", "Maximum Codex repair iterations.", "3")
  .option("--allow-copyleft", "Allow copyleft-licensed repositories.")
  .option("--force", "Clear the output directory before materializing the main repo.")
  .option("--model <model>", "Codex model override.")
  .action(async (requirement: string, options: CliOptions) => {
    const orchestrator = createOrchestrator(options);
    const prepared = await orchestrator.prepare(requirement, "interactive");
    const selected = await checkbox({
      message: "Select repositories Kakashi may use",
      required: true,
      choices: prepared.analyses.map((analysis) => ({
        name: `${analysis.candidate.fullName} (${analysis.candidate.license}, ${analysis.candidate.stars} stars)`,
        value: analysis.candidate.fullName,
        checked:
          analysis.candidate.fullName === prepared.plan.main.repo.fullName ||
          prepared.plan.auxiliaries.some((source) => source.repo.fullName === analysis.candidate.fullName)
      }))
    });

    const analyses = prepared.analyses.filter((analysis) => selected.includes(analysis.candidate.fullName));
    const graph = new CapabilityGraphBuilder().build(prepared.plan.requirement.capabilities, analyses);
    const plan = new FusionPlanner().createPlanForRequirement(graph, prepared.plan.requirement, {
      outputDir: options.out
    });

    printPlan(plan);
    const ok = await confirm({ message: "Execute this fusion plan?", default: true });
    if (!ok) {
      console.log(pc.yellow("Cancelled before Codex execution."));
      return;
    }

    const state = await orchestrator.executePrepared(prepared.state, plan);
    printFinalState(state);
  });

program
  .command("serve")
  .description("Start the local Kakashi API server and optionally serve the built Web UI.")
  .option("--port <number>", "Port to listen on.", "4317")
  .option("--web-dir <dir>", "Directory containing a built Kakashi Web UI.")
  .option("--no-web", "Disable serving the Web UI.")
  .action(async (options: { port: string; webDir?: string; web?: boolean }) => {
    const { startServer } = await import("@kakashi/server");
    const webDir =
      options.web === false ? undefined : options.webDir ? resolve(process.cwd(), options.webDir) : process.env.KAKASHI_WEB_DIST;
    await startServer({ port: Number(options.port), workDir: process.cwd(), webDir });
  });

program
  .command("inspect")
  .description("Inspect a previous run.")
  .argument("<runId>", "Run id.")
  .action(async (runId: string) => {
    const orchestrator = new KakashiOrchestrator({ workDir: process.cwd() });
    const state = await orchestrator.store.load(runId);
    if (!state) {
      console.error(pc.red(`Run not found: ${runId}`));
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify(state, null, 2));
  });

program.parseAsync().catch((error: unknown) => {
  console.error(pc.red(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});

interface CliOptions {
  out: string;
  maxRepos: string;
  maxIterations: string;
  allowCopyleft?: boolean;
  force?: boolean;
  model?: string;
}

function createOrchestrator(options: CliOptions): KakashiOrchestrator {
  return new KakashiOrchestrator({
    workDir: process.cwd(),
    outputDir: options.out,
    maxRepos: Number(options.maxRepos),
    maxIterations: Number(options.maxIterations),
    allowCopyleft: Boolean(options.allowCopyleft),
    force: Boolean(options.force),
    codexModel: options.model,
    onEvent: printEvent
  } satisfies Partial<KakashiOptions> & { onEvent: (event: RunEvent) => void });
}

function printEvent(event: RunEvent): void {
  const color = event.level === "error" ? pc.red : event.level === "warn" ? pc.yellow : pc.cyan;
  console.log(`${color(event.stage)} ${event.message}`);
}

function printPlan(plan: { main: { repo: { fullName: string } }; auxiliaries: Array<{ repo: { fullName: string } }>; tasks: Array<{ title: string }> }): void {
  console.log(pc.bold("\nFusion plan"));
  console.log(`Main: ${plan.main.repo.fullName}`);
  console.log(`Auxiliary: ${plan.auxiliaries.map((source) => source.repo.fullName).join(", ") || "none"}`);
  for (const task of plan.tasks) console.log(`- ${task.title}`);
}

function printFinalState(state: { stage: string; outputDir: string; error?: string; report?: { verification: { summary: string } } }): void {
  if (state.stage === "completed") {
    console.log(pc.green(`Completed: ${state.outputDir}`));
    console.log(state.report?.verification.summary);
    return;
  }
  console.error(pc.red(`Failed: ${state.error ?? state.stage}`));
  process.exitCode = 1;
}
