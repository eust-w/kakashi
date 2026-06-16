import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter } from "node:path";
import type { CommandResult } from "../types";
import { redactSecrets } from "./redaction";

export interface RunCommandOptions {
  cwd: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  input?: string;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  readyPattern?: RegExp;
  readyCheck?: (output: string) => boolean | Promise<boolean>;
  signal?: AbortSignal;
}

export async function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions
): Promise<CommandResult> {
  const started = Date.now();
  const display = shellJoin([command, ...args]);
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let aborted = false;
  let readyMatched = false;

  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32"
    });
    let readinessPoll: NodeJS.Timeout | null = null;
    let readinessCheckRunning = false;
    let readinessPatternSeen = false;

    const clearReadinessPoll = () => {
      if (!readinessPoll) return;
      clearInterval(readinessPoll);
      readinessPoll = null;
    };

    const terminate = (reason: "abort" | "ready" | "timeout") => {
      if (reason === "timeout") timedOut = true;
      if (reason === "abort") aborted = true;
      if (reason === "ready") readyMatched = true;
      clearReadinessPoll();
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      killProcessTree(child, "SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          killProcessTree(child, "SIGKILL");
        }
      }, 2_000).unref();
    };

    const output = () => `${stdout}\n${stderr}`;

    const pollReadiness = async () => {
      if (!options.readyCheck || readyMatched || readinessCheckRunning) return;
      readinessCheckRunning = true;
      try {
        if (await options.readyCheck(output())) {
          terminate("ready");
        }
      } catch {
        // Keep polling until readiness is confirmed or the command times out.
      } finally {
        readinessCheckRunning = false;
      }
    };

    const startReadinessPolling = () => {
      if (!options.readyCheck) {
        terminate("ready");
        return;
      }
      if (readinessPoll) return;
      void pollReadiness();
      readinessPoll = setInterval(() => {
        void pollReadiness();
      }, 250);
      readinessPoll.unref();
    };

    let timeout: NodeJS.Timeout | null = options.timeoutMs
      ? setTimeout(() => {
          terminate("timeout");
        }, options.timeoutMs)
      : null;

    const abortListener = () => terminate("abort");
    if (options.signal?.aborted) {
      terminate("abort");
    } else {
      options.signal?.addEventListener("abort", abortListener, { once: true });
    }

    const checkReady = () => {
      if (!options.readyPattern || readyMatched) return;
      if (!readinessPatternSeen && !options.readyPattern.test(output())) return;
      readinessPatternSeen = true;
      startReadinessPolling();
    };

    child.on("error", (error) => {
      clearReadinessPoll();
      options.signal?.removeEventListener("abort", abortListener);
      reject(error);
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EPIPE" || error.code === "ERR_STREAM_DESTROYED") return;
      clearReadinessPoll();
      options.signal?.removeEventListener("abort", abortListener);
      reject(error);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      const text = redactSecrets(chunk.toString("utf8"));
      stdout += text;
      options.onStdout?.(text);
      checkReady();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = redactSecrets(chunk.toString("utf8"));
      stderr += text;
      options.onStderr?.(text);
      checkReady();
    });
    child.on("close", (exitCode, signal) => {
      clearReadinessPoll();
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abortListener);
      resolve({
        command: display,
        cwd: options.cwd,
        exitCode: readyMatched ? 0 : exitCode,
        signal: readyMatched ? null : signal,
        stdout: truncate(stdout),
        stderr: truncate(stderr),
        durationMs: Date.now() - started,
        timedOut: readyMatched || aborted ? false : timedOut,
        aborted,
        ready: readyMatched
      });
    });

    if (options.input) {
      child.stdin.write(options.input);
    }
    child.stdin.end();
  });
}

function killProcessTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (process.platform !== "win32") {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Process is already gone.
    }
  }
}

export function shellJoin(parts: string[]): string {
  return parts
    .map((part) => (/^[A-Za-z0-9_./:=@-]+$/.test(part) ? part : JSON.stringify(part)))
    .join(" ");
}

export async function findExecutable(command: string): Promise<string | null> {
  const paths = (process.env.PATH ?? "").split(delimiter);
  for (const path of paths) {
    const candidate = `${path}/${command}`;
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue.
    }
  }
  return null;
}

function truncate(input: string, max = 80_000): string {
  if (input.length <= max) return input;
  return `${input.slice(0, max)}\n...[truncated ${input.length - max} chars]`;
}
