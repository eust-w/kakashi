import express from "express";
import cors from "cors";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { KakashiOrchestrator, type KakashiRunState, type RunEvent } from "@kakashi/core";

export interface ServerOptions {
  port: number;
  workDir: string;
  webDir?: string;
  webAssets?: EmbeddedWebAssets;
}

export interface EmbeddedWebAsset {
  contentType: string;
  contentBase64: string;
}

export type EmbeddedWebAssets = Record<string, EmbeddedWebAsset>;

interface WebAssetSource {
  webDir?: string;
  webAssets?: EmbeddedWebAssets;
}

const CreateRunSchema = z.object({
  mode: z.enum(["auto", "interactive"]).default("auto"),
  requirement: z.string().min(1),
  outputDir: z.string().min(1),
  options: z
    .object({
      maxRepos: z.number().int().positive().max(50).optional(),
      maxIterations: z.number().int().positive().max(10).optional(),
      allowCopyleft: z.boolean().optional(),
      force: z.boolean().optional(),
      codexModel: z.string().optional()
    })
    .optional()
});

const ConfirmSchema = z.object({
  confirmed: z.boolean()
});

const running = new Map<string, KakashiOrchestrator>();
const events = new EventEmitter();
events.setMaxListeners(1_000);

export function createApp(workDir = process.cwd(), web?: string | WebAssetSource): express.Express {
  const webSource: WebAssetSource = typeof web === "string" ? { webDir: web } : web ?? {};
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "kakashi-server" });
  });

  app.get("/api/runs", async (_req, res, next) => {
    try {
      const orchestrator = createOrchestrator(workDir, ".", {});
      res.json(await orchestrator.store.list());
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/runs", async (req, res, next) => {
    try {
      const body = CreateRunSchema.parse(req.body);
      const orchestrator = createOrchestrator(workDir, body.outputDir, body.options ?? {});
      const state = await orchestrator.createState(body.requirement, body.mode);
      running.set(state.runId, orchestrator);
      res.status(202).json(state);

      if (body.mode === "auto") {
        void orchestrator.runState(state).finally(() => running.delete(state.runId));
      } else {
        void orchestrator.prepareState(state).catch(() => undefined);
      }
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/runs/:id", async (req, res, next) => {
    try {
      const orchestrator = running.get(req.params.id) ?? createOrchestrator(workDir, ".", {});
      const state = await orchestrator.store.load(req.params.id);
      if (!state) {
        res.status(404).json({ error: "Run not found" });
        return;
      }
      res.json(state);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/runs/:id/events", async (req, res, next) => {
    try {
      const orchestrator = running.get(req.params.id) ?? createOrchestrator(workDir, ".", {});
      const existing = await orchestrator.store.events(req.params.id);
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      });
      for (const event of existing) sendSse(res, event);

      const listener = (event: RunEvent) => {
        if (event.runId === req.params.id) sendSse(res, event);
      };
      events.on("run-event", listener);
      req.on("close", () => events.off("run-event", listener));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/runs/:id/confirm-plan", async (req, res, next) => {
    try {
      const body = ConfirmSchema.parse(req.body);
      const orchestrator = running.get(req.params.id);
      if (!orchestrator) {
        res.status(404).json({ error: "Interactive run is not active." });
        return;
      }
      const state = await orchestrator.store.load(req.params.id);
      if (!state?.plan) {
        res.status(409).json({ error: "Fusion plan is not ready." });
        return;
      }
      if (!body.confirmed) {
        const cancelled: KakashiRunState = { ...state, stage: "cancelled", error: "Cancelled by user." };
        await orchestrator.store.save(cancelled);
        res.json(cancelled);
        return;
      }
      res.status(202).json(state);
      void orchestrator.executePrepared(state, state.plan).finally(() => running.delete(req.params.id));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/runs/:id/cancel", async (req, res, next) => {
    try {
      const orchestrator = running.get(req.params.id) ?? createOrchestrator(workDir, ".", {});
      const state = await orchestrator.store.load(req.params.id);
      if (!state) {
        res.status(404).json({ error: "Run not found" });
        return;
      }
      const cancelled: KakashiRunState = { ...state, stage: "cancelled", error: "Cancelled by user." };
      await orchestrator.store.save(cancelled);
      running.delete(req.params.id);
      res.json(cancelled);
    } catch (error) {
      next(error);
    }
  });

  const indexPath = webSource.webDir ? join(webSource.webDir, "index.html") : null;
  if (webSource.webDir && indexPath && existsSync(indexPath)) {
    app.use(express.static(webSource.webDir));
    app.get(/^\/(?!api\/|health$).*/, (_req, res) => {
      res.sendFile(indexPath);
    });
  } else if (webSource.webAssets && Object.keys(webSource.webAssets).length > 0) {
    app.get(/^\/(?!api\/|health$).*/, (req, res) => {
      const key = normalizeAssetPath(req.path);
      const asset = webSource.webAssets?.[key] ?? webSource.webAssets?.["index.html"];
      if (!asset) {
        res.status(404).json({ error: "Web asset not found." });
        return;
      }
      res.type(asset.contentType).send(Buffer.from(asset.contentBase64, "base64"));
    });
  }

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ error: message });
  });

  return app;
}

export async function startServer(options: ServerOptions): Promise<void> {
  const app = createApp(options.workDir, { webDir: options.webDir, webAssets: options.webAssets });
  await new Promise<void>((resolveListen) => {
    app.listen(options.port, "127.0.0.1", () => resolveListen());
  });
  console.log(`Kakashi server listening on http://127.0.0.1:${options.port}`);
  if (options.webDir) {
    console.log(`Kakashi web UI served from ${options.webDir}`);
  } else if (options.webAssets && Object.keys(options.webAssets).length > 0) {
    console.log("Kakashi web UI served from embedded assets");
  }
}

function createOrchestrator(
  workDir: string,
  outputDir: string,
  options: {
    maxRepos?: number;
    maxIterations?: number;
    allowCopyleft?: boolean;
    force?: boolean;
    codexModel?: string;
  }
): KakashiOrchestrator {
  return new KakashiOrchestrator({
    workDir,
    outputDir: resolve(workDir, outputDir),
    maxRepos: options.maxRepos,
    maxIterations: options.maxIterations,
    allowCopyleft: options.allowCopyleft,
    force: options.force,
    codexModel: options.codexModel,
    onEvent: (event: RunEvent) => events.emit("run-event", event)
  });
}

function sendSse(res: express.Response, event: RunEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

if (isDirectExecution()) {
  void startFromCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

async function startFromCli(): Promise<void> {
  const portArg = process.argv.find((arg) => arg.startsWith("--port="));
  const webDirArg = process.argv.find((arg) => arg.startsWith("--web-dir="));
  const port = portArg ? Number(portArg.split("=")[1]) : Number(process.env.PORT ?? 4317);
  const webDir = webDirArg ? resolve(process.cwd(), webDirArg.split("=")[1] ?? "") : process.env.KAKASHI_WEB_DIST;
  await startServer({ port, workDir: process.cwd(), webDir });
}

function isDirectExecution(): boolean {
  return Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);
}

function normalizeAssetPath(path: string): string {
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    decoded = path;
  }
  const clean = decoded.replace(/^\/+/, "");
  if (!clean || clean.endsWith("/")) return "index.html";
  return clean.replace(/\.\.(\/|\\)/g, "");
}
