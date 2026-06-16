import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { KakashiRunState, RunEvent, RunStage } from "./types";
import { ensureDir, pathExists, writeJsonFile } from "./utils/fs";
import { createRunId } from "./utils/ids";
import { redactObject } from "./utils/redaction";

export class RunStore {
  constructor(private readonly rootDir: string) {}

  async create(mode: KakashiRunState["mode"], requirementText: string, outputDir: string): Promise<KakashiRunState> {
    const runId = createRunId();
    const now = new Date().toISOString();
    const state: KakashiRunState = {
      runId,
      mode,
      stage: "created",
      requirementText,
      outputDir,
      createdAt: now,
      updatedAt: now
    };
    await this.save(state);
    await this.appendEvent(runId, "created", "info", "Run created.");
    return state;
  }

  async save(state: KakashiRunState): Promise<void> {
    const next = { ...state, updatedAt: new Date().toISOString() };
    await writeJsonFile(this.statePath(state.runId), redactObject(next));
  }

  async load(runId: string): Promise<KakashiRunState | null> {
    const path = this.statePath(runId);
    if (!(await pathExists(path))) return null;
    return JSON.parse(await readFile(path, "utf8")) as KakashiRunState;
  }

  async list(): Promise<KakashiRunState[]> {
    const dir = this.rootDir;
    if (!(await pathExists(dir))) return [];
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(dir, { withFileTypes: true });
    const states = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .filter((entry) => isValidRunId(entry.name))
        .map((entry) => this.load(entry.name))
    );
    return states
      .filter((state): state is KakashiRunState => Boolean(state))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async appendEvent(
    runId: string,
    stage: RunStage,
    level: RunEvent["level"],
    message: string,
    data?: unknown
  ): Promise<RunEvent> {
    const event: RunEvent = {
      id: createRunId(),
      runId,
      timestamp: new Date().toISOString(),
      stage,
      level,
      message,
      data: data === undefined ? undefined : redactObject(data)
    };
    await ensureDir(this.runDir(runId));
    await appendFile(this.eventsPath(runId), `${JSON.stringify(event)}\n`, "utf8");
    await this.syncStageFromEvent(runId, stage);
    return event;
  }

  async events(runId: string): Promise<RunEvent[]> {
    const path = this.eventsPath(runId);
    if (!(await pathExists(path))) return [];
    return (await readFile(path, "utf8"))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RunEvent);
  }

  private statePath(runId: string): string {
    return join(this.runDir(runId), "state.json");
  }

  private eventsPath(runId: string): string {
    return join(this.runDir(runId), "events.jsonl");
  }

  private async syncStageFromEvent(runId: string, stage: RunStage): Promise<void> {
    const state = await this.load(runId);
    if (!state || state.stage === stage || isTerminalStage(state.stage)) return;
    await this.save({ ...state, stage });
  }

  private runDir(runId: string): string {
    return join(this.rootDir, validateRunId(runId));
  }
}

function isTerminalStage(stage: RunStage): boolean {
  return stage === "completed" || stage === "failed" || stage === "cancelled";
}

function validateRunId(runId: string): string {
  if (!isValidRunId(runId)) {
    throw new Error("Invalid run id.");
  }
  return runId;
}

function isValidRunId(runId: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(runId);
}
