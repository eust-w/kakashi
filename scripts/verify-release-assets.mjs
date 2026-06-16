#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const version = (process.env.RELEASE_VERSION || (await import("../package.json", { with: { type: "json" } })).default.version).replace(/^v/, "");
const hostTarget = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
const executableName = `kakashi-v${version}-${hostTarget}${process.platform === "win32" ? ".exe" : ""}`;
const executablePath = join(rootDir, "dist", "executables", executableName);
const bundlePath = join(rootDir, "dist", "release", ".bundle", "kakashi.mjs");

const verifyDir = await mkdtemp(join(tmpdir(), "kakashi-release-verify-"));
await verifyCli(bundlePath, ["runs", "--json"], "release bundle CLI");
await verifyCli(executablePath, ["runs", "--json"], "single-file executable CLI");
await verifyEmbeddedWebUi(executablePath);

console.log(`verified release assets for ${hostTarget}`);

async function verifyCli(command, args, label) {
  const result = await run(command.endsWith(".mjs") ? process.execPath : command, command.endsWith(".mjs") ? [command, ...args] : args);
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed with exit ${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  JSON.parse(result.stdout);
}

async function verifyEmbeddedWebUi(command) {
  const port = await getOpenPort();
  const child = spawn(command, ["serve", "--port", String(port)], {
    cwd: verifyDir,
    env: { ...process.env, KAKASHI_WEB_DIST: "" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const output = captureOutput(child);
  try {
    await waitForHttp(`http://127.0.0.1:${port}/health`, "kakashi-server");
    const index = await fetchText(`http://127.0.0.1:${port}/`);
    if (!/<html/i.test(index) || !/Kakashi/i.test(index)) {
      throw new Error(`Embedded Web UI did not return Kakashi HTML. Body:\n${index.slice(0, 500)}`);
    }
  } catch (error) {
    throw new Error(
      [
        error instanceof Error ? error.message : String(error),
        `server stdout:\n${tail(output.stdout) || "<empty>"}`,
        `server stderr:\n${tail(output.stderr) || "<empty>"}`
      ].join("\n")
    );
  } finally {
    child.kill("SIGTERM");
    if (child.exitCode === null) await once(child, "exit");
  }
}

async function run(command, args) {
  return await new Promise((resolveRun) => {
    const child = spawn(command, args, {
      cwd: verifyDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const output = captureOutput(child);
    child.on("error", (error) => {
      resolveRun({ exitCode: -1, stdout: output.stdout, stderr: String(error) });
    });
    child.on("close", (exitCode) => {
      resolveRun({ exitCode, stdout: output.stdout, stderr: output.stderr });
    });
  });
}

async function waitForHttp(url, expectedText) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const text = await fetchText(url);
      if (text.includes(expectedText)) return;
    } catch {
      await delay(100);
    }
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function fetchText(url) {
  return await new Promise((resolveFetch, rejectFetch) => {
    const request = get(url, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        const statusCode = response.statusCode ?? 0;
        if (statusCode < 200 || statusCode >= 300) {
          rejectFetch(new Error(`${url} returned ${statusCode}`));
          return;
        }
        resolveFetch(body);
      });
    });
    request.on("error", rejectFetch);
  });
}

async function getOpenPort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  server.close();
  await once(server, "close");
  return address.port;
}

function captureOutput(child) {
  const output = { stdout: "", stderr: "" };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output.stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output.stderr += chunk;
  });
  return output;
}

function tail(value) {
  return value.trim().slice(-4_000);
}
