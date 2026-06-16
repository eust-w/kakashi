#!/usr/bin/env node
import { Command } from "commander";
import { isAbsolute, relative, resolve } from "node:path";
import pc from "picocolors";
import { checkbox, confirm } from "@inquirer/prompts";
import { getEmbeddedWebAssets } from "./runtime-web-assets";
import {
  CapabilityGraphBuilder,
  Doctor,
  FusionPlanner,
  KakashiOrchestrator,
  type KakashiRunState,
  type OrchestratorOptions,
  type RunEvent
} from "@kakashi/core";

const program = new Command();

program
  .name("kakashi")
  .description("GitHub multi-repository capability fusion orchestrator for Codex CLI/Desktop.")
  .version("0.2.0");

program
  .command("doctor")
  .description("Check local Kakashi prerequisites.")
  .option("--json", "Print machine-readable JSON.")
  .action(async (options: JsonOptions) => {
    const checks = await new Doctor().run(process.cwd());
    if (options.json) {
      printJson(checks);
      return;
    }
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
  .option("--json", "Print final run state as JSON and suppress progress logs.")
  .action(async (requirement: string, options: CliOptions) => {
    const orchestrator = createOrchestrator(options);
    const state = await orchestrator.run(requirement, "auto");
    printFinalState(state, options);
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
    printFinalState(state, options);
  });

program
  .command("serve")
  .description("Start the local Kakashi API server and optionally serve the built Web UI.")
  .option("--port <number>", "Port to listen on.", "4317")
  .option("--web-dir <dir>", "Directory containing a built Kakashi Web UI.")
  .option("--no-web", "Disable serving the Web UI.")
  .action(async (options: ServeOptions) => {
    const port = parsePort(options.port);
    const { startServer } = await import("@kakashi/server");
    const webDir =
      options.web === false ? undefined : options.webDir ? resolve(process.cwd(), options.webDir) : process.env.KAKASHI_WEB_DIST;
    const webAssets = options.web === false || webDir ? undefined : getEmbeddedWebAssets();
    await startServer({ port, workDir: process.cwd(), webDir, webAssets });
  });

program
  .command("inspect")
  .description("Inspect a previous run.")
  .argument("<runId>", "Run id.")
  .option("--json", "Print machine-readable JSON. This is the default for inspect.")
  .action(async (runId: string) => {
    const orchestrator = new KakashiOrchestrator({ workDir: process.cwd() });
    const state = await orchestrator.store.load(runId);
    if (!state) {
      printError(`Run not found: ${runId}`, { json: true });
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify(state, null, 2));
  });

program
  .command("runs")
  .description("List previous Kakashi runs from the current workspace.")
  .option("--json", "Print machine-readable JSON.")
  .option("--limit <number>", "Maximum number of runs to print.", "20")
  .action(async (options: RunListOptions) => {
    const orchestrator = new KakashiOrchestrator({ workDir: process.cwd() });
    const limit = parsePositiveInteger(options.limit, "limit");
    const runs = (await orchestrator.store.list()).slice(0, limit);
    if (options.json) {
      printJson(runs);
      return;
    }
    printRunList(runs);
  });

program
  .command("events")
  .description("Print the append-only event log for a previous run.")
  .argument("<runId>", "Run id.")
  .option("--json", "Print machine-readable JSON.")
  .action(async (runId: string, options: JsonOptions) => {
    const orchestrator = new KakashiOrchestrator({ workDir: process.cwd() });
    const state = await orchestrator.store.load(runId);
    if (!state) {
      printError(`Run not found: ${runId}`, options);
      process.exitCode = 1;
      return;
    }
    const events = await orchestrator.store.events(runId);
    if (options.json) {
      printJson(events);
      return;
    }
    printEventLog(events);
  });

program.parseAsync().catch((error: unknown) => {
  printError(error instanceof Error ? error.message : String(error), { json: process.argv.includes("--json") });
  process.exitCode = 1;
});

interface CliOptions {
  out: string;
  maxRepos: string;
  maxIterations: string;
  allowCopyleft?: boolean;
  force?: boolean;
  model?: string;
  json?: boolean;
}

interface JsonOptions {
  json?: boolean;
}

interface RunListOptions extends JsonOptions {
  limit: string;
}

interface ServeOptions {
  port: string;
  webDir?: string;
  web?: boolean;
}

function createOrchestrator(options: CliOptions): KakashiOrchestrator {
  const workDir = process.cwd();
  const orchestratorOptions: OrchestratorOptions = {
    workDir,
    outputDir: resolveSafeOutputDir(workDir, options.out),
    maxRepos: parsePositiveInteger(options.maxRepos, "max-repos"),
    maxIterations: parsePositiveInteger(options.maxIterations, "max-iterations"),
    allowCopyleft: Boolean(options.allowCopyleft),
    force: Boolean(options.force),
    codexModel: options.model,
    onEvent: options.json ? undefined : printEvent
  };
  return new KakashiOrchestrator(orchestratorOptions);
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

function printFinalState(
  state: { stage: string; outputDir: string; error?: string; report?: { verification: { summary: string } } },
  options: JsonOptions
): void {
  if (options.json) {
    printJson(state);
    if (state.stage !== "completed") process.exitCode = 1;
    return;
  }
  if (state.stage === "completed") {
    console.log(pc.green(`Completed: ${state.outputDir}`));
    console.log(state.report?.verification.summary);
    return;
  }
  console.error(pc.red(`Failed: ${state.error ?? state.stage}`));
  process.exitCode = 1;
}

function printRunList(runs: KakashiRunState[]): void {
  if (runs.length === 0) {
    console.log(pc.dim("No Kakashi runs found in this workspace."));
    return;
  }
  for (const run of runs) {
    console.log(
      [
        run.runId,
        run.stage.padEnd(24),
        run.mode.padEnd(11),
        run.updatedAt,
        truncate(run.requirementText, 80)
      ].join("  ")
    );
  }
}

function printEventLog(events: RunEvent[]): void {
  if (events.length === 0) {
    console.log(pc.dim("No events recorded for this run."));
    return;
  }
  for (const event of events) {
    const level = event.level.toUpperCase().padEnd(5);
    console.log(`${event.timestamp}  ${level}  ${event.stage.padEnd(24)}  ${event.message}`);
  }
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printError(message: string, options: JsonOptions): void {
  if (options.json) {
    console.error(JSON.stringify({ error: message }, null, 2));
    return;
  }
  console.error(pc.red(message));
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function resolveSafeOutputDir(workDir: string, outputDir: string): string {
  const root = resolve(workDir);
  const resolved = resolve(root, outputDir);
  const fromOutputToWorkDir = relative(resolved, root);
  if (!fromOutputToWorkDir || (!fromOutputToWorkDir.startsWith("..") && !isAbsolute(fromOutputToWorkDir))) {
    throw new Error("Output directory must not be the current workspace or one of its parent directories.");
  }
  return resolved;
}

function parsePort(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("port must be an integer between 1 and 65535.");
  }
  return parsed;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}
