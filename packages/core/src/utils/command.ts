import { spawn } from "node:child_process";
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
  let readyMatched = false;

  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"]
    });

    let timeout: NodeJS.Timeout | null = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          setTimeout(() => {
            if (!child.killed) child.kill("SIGKILL");
          }, 2_000).unref();
        }, options.timeoutMs)
      : null;

    const checkReady = () => {
      if (!options.readyPattern || readyMatched) return;
      if (!options.readyPattern.test(`${stdout}\n${stderr}`)) return;
      readyMatched = true;
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 2_000).unref();
    };

    child.on("error", reject);
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
      if (timeout) clearTimeout(timeout);
      resolve({
        command: display,
        cwd: options.cwd,
        exitCode: readyMatched ? 0 : exitCode,
        signal: readyMatched ? null : signal,
        stdout: truncate(stdout),
        stderr: truncate(stderr),
        durationMs: Date.now() - started,
        timedOut: readyMatched ? false : timedOut
      });
    });

    if (options.input) {
      child.stdin.write(options.input);
    }
    child.stdin.end();
  });
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
      await access(candidate);
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
