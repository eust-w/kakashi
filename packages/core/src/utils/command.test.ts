import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { findExecutable, runCommand, shellJoin } from "./command";

describe("runCommand", () => {
  it("terminates a long-running process after matching real readiness output", async () => {
    const result = await runCommand(
      process.execPath,
      ["-e", "console.log('server ready on http://127.0.0.1:3210'); setInterval(() => {}, 1000);"],
      {
        cwd: process.cwd(),
        timeoutMs: 5_000,
        readyPattern: /server ready/i
      }
    );

    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toContain("server ready");
    expect(result.durationMs).toBeLessThan(5_000);
  });

  it("captures non-zero exits and redacts streamed stdout", async () => {
    const result = await runCommand(
      process.execPath,
      ["-e", "process.stdin.pipe(process.stdout); process.stdin.on('end', () => process.exit(7));"],
      {
        cwd: process.cwd(),
        input: "api_key=secret-value\n"
      }
    );

    expect(result.exitCode).toBe(7);
    expect(result.signal).toBeNull();
    expect(result.stdout).toContain("[REDACTED]");
    expect(result.stdout).not.toContain("secret-value");
  });

  it("returns the child result when the process exits before reading provided stdin", async () => {
    const result = await runCommand(process.execPath, ["-e", "process.stdin.destroy(); process.exit(7);"], {
      cwd: process.cwd(),
      input: "x".repeat(1_000_000)
    });

    expect(result.exitCode).toBe(7);
  });

  it("captures stderr/stdout callbacks", async () => {
    let stdout = "";
    let stderr = "";
    const callbackResult = await runCommand(
      process.execPath,
      ["-e", "console.log('callback-out'); console.error('callback-err')"],
      {
        cwd: process.cwd(),
        onStdout: (chunk) => {
          stdout += chunk;
        },
        onStderr: (chunk) => {
          stderr += chunk;
        }
      }
    );

    expect(callbackResult.exitCode).toBe(0);
    expect(stdout).toContain("callback-out");
    expect(stderr).toContain("callback-err");
  });

  it("marks timed-out command results", async () => {
    const timeoutResult = await runCommand(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
      cwd: process.cwd(),
      timeoutMs: 50
    });
    expect(timeoutResult.timedOut).toBe(true);
    expect(timeoutResult.exitCode).toBeNull();
  });

  it("truncates long command output", async () => {
    const longResult = await runCommand(process.execPath, ["-e", "console.log('x'.repeat(81000))"], {
      cwd: process.cwd()
    });
    expect(longResult.stdout).toContain("[truncated");
  }, 15_000);

  it("terminates a running process when the abort signal fires", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20).unref();

    const result = await runCommand(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
      cwd: process.cwd(),
      timeoutMs: 200,
      signal: controller.signal
    } as Parameters<typeof runCommand>[2] & { signal: AbortSignal });

    expect(result.timedOut).toBe(false);
    expect(result.aborted).toBe(true);
    expect(result.exitCode).toBeNull();
  });

  it("rejects spawn errors and finds executables on PATH", async () => {
    await expect(runCommand("kakashi-definitely-missing-command", [], { cwd: process.cwd() })).rejects.toThrow();
    await expect(findExecutable("kakashi-definitely-missing-command")).resolves.toBeNull();
    await expect(findExecutable("node")).resolves.toEqual(expect.stringContaining("/"));
  });

  it("does not report non-executable files as available commands", async () => {
    const originalPath = process.env.PATH;
    const binDir = await mkdtemp(join(tmpdir(), "kakashi-path-"));
    await writeFile(join(binDir, "kakashi-not-executable"), "#!/bin/sh\necho no\n", { mode: 0o644 });
    process.env.PATH = [binDir, ...(originalPath ? originalPath.split(delimiter) : [])].join(delimiter);
    try {
      await expect(findExecutable("kakashi-not-executable")).resolves.toBeNull();
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

describe("shellJoin", () => {
  it("quotes shell arguments only when needed", () => {
    expect(shellJoin(["npm", "run", "test:e2e"])).toBe("npm run test:e2e");
    expect(shellJoin(["node", "-e", "console.log('hello world')"])).toBe("node -e \"console.log('hello world')\"");
  });
});
