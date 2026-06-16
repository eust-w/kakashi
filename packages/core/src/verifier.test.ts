import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Verifier } from "./verifier";

describe("Verifier", () => {
  it("detects meaningful Node install, build, and test steps", async () => {
    const dir = join(tmpdir(), `kakashi-verifier-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        packageManager: "pnpm@10.33.0",
        scripts: {
          build: "tsc",
          test: "vitest run",
          lint: "eslint ."
        }
      }),
      "utf8"
    );

    const steps = await new Verifier().detect(dir);

    expect(steps.map((step) => step.name)).toEqual(["pnpm install", "pnpm lint", "pnpm build", "pnpm test"]);
  });

  it("detects built CLI help verification and skips watch scripts", async () => {
    const dir = join(tmpdir(), `kakashi-verifier-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        name: "sample-cli",
        bin: {
          sample: "./dist/cli.js"
        },
        scripts: {
          build: "tsup",
          dev: "tsup --watch",
          test: "vitest run"
        }
      }),
      "utf8"
    );

    const steps = await new Verifier().detect(dir);

    expect(steps.map((step) => step.name)).toEqual(["npm install", "npm build", "npm test", "sample CLI help"]);
  });

  it("detects string bin fields and lockfile package managers", async () => {
    const pnpmDir = join(tmpdir(), `kakashi-verifier-${randomUUID()}`);
    const yarnDir = join(tmpdir(), `kakashi-verifier-${randomUUID()}`);
    await mkdir(pnpmDir, { recursive: true });
    await mkdir(yarnDir, { recursive: true });
    await writeFile(
      join(pnpmDir, "package.json"),
      JSON.stringify({
        name: "string-bin",
        bin: "./bin/cli.js"
      }),
      "utf8"
    );
    await writeFile(join(pnpmDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    await writeFile(join(yarnDir, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }), "utf8");
    await writeFile(join(yarnDir, "yarn.lock"), "# yarn lockfile\n", "utf8");

    await expect(new Verifier().detect(pnpmDir)).resolves.toEqual([
      { name: "pnpm install", command: ["pnpm", "install"], required: true },
      { name: "string-bin CLI help", command: ["node", "./bin/cli.js", "--help"], required: true }
    ]);
    expect((await new Verifier().detect(yarnDir))[0]).toEqual({
      name: "yarn install",
      command: ["yarn", "install"],
      required: true
    });
  });

  it("detects server readiness verification for real dev servers", async () => {
    const dir = join(tmpdir(), `kakashi-verifier-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        scripts: {
          dev: "vite --host 127.0.0.1"
        },
        devDependencies: {
          vite: "^7.0.0"
        }
      }),
      "utf8"
    );

    const steps = await new Verifier().detect(dir);

    expect(steps).toEqual([
      { name: "npm install", command: ["npm", "install"], required: true },
      {
        name: "npm dev readiness",
        command: ["npm", "run", "dev"],
        required: true,
        mode: "readiness"
      }
    ]);
  });

  it("fails readiness when a server logs ready but does not serve healthy HTTP", async () => {
    const dir = join(tmpdir(), `kakashi-verifier-${randomUUID()}`);
    const port = await getOpenPort();
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        scripts: {
          start: "node server.mjs"
        }
      }),
      "utf8"
    );
    await writeFile(
      join(dir, "server.mjs"),
      [
        "import { createServer } from 'node:http';",
        `const port = ${port};`,
        "createServer((_req, res) => {",
        "  res.writeHead(503, { 'content-type': 'text/plain' });",
        "  res.end('not ready');",
        "}).listen(port, '127.0.0.1', () => {",
        "  console.log(`listening on http://127.0.0.1:${port}`);",
        "});"
      ].join("\n"),
      "utf8"
    );

    const result = await new Verifier().verify(dir, 750);

    expect(result.ok).toBe(false);
    expect(result.summary).toBe("Verification failed at npm start readiness.");
  });

  it("confirms server readiness by probing the logged local HTTP URL", async () => {
    const dir = join(tmpdir(), `kakashi-verifier-${randomUUID()}`);
    const port = await getOpenPort();
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        scripts: {
          start: "node server.mjs"
        }
      }),
      "utf8"
    );
    await writeFile(
      join(dir, "server.mjs"),
      [
        "import { writeFileSync } from 'node:fs';",
        "import { createServer } from 'node:http';",
        `const port = ${port};`,
        "createServer((req, res) => {",
        "  writeFileSync('readiness-probe.txt', req.url ?? '/');",
        "  res.writeHead(204);",
        "  res.end();",
        "}).listen(port, '127.0.0.1', () => {",
        "  console.log(`listening on http://127.0.0.1:${port}`);",
        "});"
      ].join("\n"),
      "utf8"
    );

    const result = await new Verifier().verify(dir, 5_000);

    expect(result.ok).toBe(true);
    expect(result.steps.find((step) => step.name === "npm start readiness")?.result.ready).toBe(true);
    await expect(readFile(join(dir, "readiness-probe.txt"), "utf8")).resolves.toBe("/");
  });

  it("accepts API server readiness when the base URL is 404 but a health endpoint is healthy", async () => {
    const dir = join(tmpdir(), `kakashi-verifier-${randomUUID()}`);
    const port = await getOpenPort();
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        scripts: {
          start: "node server.mjs"
        }
      }),
      "utf8"
    );
    await writeFile(
      join(dir, "server.mjs"),
      [
        "import { appendFileSync } from 'node:fs';",
        "import { createServer } from 'node:http';",
        `const port = ${port};`,
        "createServer((req, res) => {",
        "  appendFileSync('readiness-probes.txt', `${req.url}\\n`);",
        "  if (req.url === '/health') {",
        "    res.writeHead(200, { 'content-type': 'application/json' });",
        "    res.end('{\"ok\":true}');",
        "    return;",
        "  }",
        "  res.writeHead(404, { 'content-type': 'text/plain' });",
        "  res.end('not found');",
        "}).listen(port, '127.0.0.1', () => {",
        "  console.log(`listening on http://127.0.0.1:${port}`);",
        "});"
      ].join("\n"),
      "utf8"
    );

    const result = await new Verifier().verify(dir, 5_000);

    expect(result.ok).toBe(true);
    await expect(readFile(join(dir, "readiness-probes.txt"), "utf8")).resolves.toContain("/health");
  });

  it("detects Node server scripts without treating watch/build scripts as runnable", async () => {
    const serverDir = join(tmpdir(), `kakashi-verifier-${randomUUID()}`);
    const serveDir = join(tmpdir(), `kakashi-verifier-${randomUUID()}`);
    const ignoredDir = join(tmpdir(), `kakashi-verifier-${randomUUID()}`);
    await mkdir(serverDir, { recursive: true });
    await mkdir(serveDir, { recursive: true });
    await mkdir(ignoredDir, { recursive: true });
    await writeFile(
      join(serverDir, "package.json"),
      JSON.stringify({
        scripts: {
          start: "node dist/server.js"
        },
        dependencies: {
          express: "^5.0.0"
        }
      }),
      "utf8"
    );
    await writeFile(
      join(serveDir, "package.json"),
      JSON.stringify({
        scripts: {
          dev: "serve dist"
        },
        dependencies: {
          express: "^5.0.0"
        }
      }),
      "utf8"
    );
    await writeFile(
      join(ignoredDir, "package.json"),
      JSON.stringify({
        scripts: {
          dev: "vite build",
          test: "echo \"Error: no test specified\" && exit 1"
        },
        devDependencies: {
          vite: "^7.0.0"
        }
      }),
      "utf8"
    );

    expect((await new Verifier().detect(serverDir)).at(-1)).toMatchObject({ name: "npm start readiness" });
    expect((await new Verifier().detect(serveDir)).at(-1)).toMatchObject({ name: "npm dev readiness" });
    await expect(new Verifier().detect(ignoredDir)).resolves.toEqual([
      { name: "npm install", command: ["npm", "install"], required: true }
    ]);
  });

  it("detects Python, Go, and Rust verification commands", async () => {
    const root = join(tmpdir(), `kakashi-verifier-${randomUUID()}`);
    const pythonDir = join(root, "python");
    const goDir = join(root, "go");
    const rustDir = join(root, "rust");
    await mkdir(join(pythonDir, "tests"), { recursive: true });
    await mkdir(goDir, { recursive: true });
    await mkdir(rustDir, { recursive: true });
    await writeFile(join(pythonDir, "requirements.txt"), "pytest\n", "utf8");
    await writeFile(join(goDir, "go.mod"), "module example.com/kakashi\n", "utf8");
    await writeFile(join(rustDir, "Cargo.toml"), "[package]\nname='kakashi'\nversion='0.0.1'\nedition='2021'\n", "utf8");

    await expect(new Verifier().detect(pythonDir)).resolves.toEqual([
      {
        name: "pip install requirements",
        command: ["python3", "-m", "pip", "install", "-r", "requirements.txt"],
        required: true
      },
      { name: "pytest", command: ["python3", "-m", "pytest"], required: true }
    ]);
    await expect(new Verifier().detect(goDir)).resolves.toEqual([
      { name: "go test", command: ["go", "test", "./..."], required: true },
      { name: "go build", command: ["go", "build", "./..."], required: true }
    ]);
    await expect(new Verifier().detect(rustDir)).resolves.toEqual([
      { name: "cargo test", command: ["cargo", "test"], required: true },
      { name: "cargo build", command: ["cargo", "build"], required: true }
    ]);
  });

  it("combines verification commands for polyglot projects with multiple manifests", async () => {
    const dir = join(tmpdir(), `kakashi-verifier-${randomUUID()}`);
    await mkdir(join(dir, "tests"), { recursive: true });
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        packageManager: "pnpm@10.33.0",
        scripts: {
          build: "tsc",
          test: "vitest run"
        }
      }),
      "utf8"
    );
    await writeFile(join(dir, "requirements.txt"), "pytest\n", "utf8");
    await writeFile(join(dir, "go.mod"), "module example.com/kakashi\n", "utf8");

    const steps = await new Verifier().detect(dir);

    expect(steps.map((step) => step.name)).toEqual([
      "pnpm install",
      "pnpm build",
      "pnpm test",
      "pip install requirements",
      "pytest",
      "go test",
      "go build"
    ]);
  });

  it("detects nested monorepo verification commands with real working directories", async () => {
    const dir = join(tmpdir(), `kakashi-verifier-${randomUUID()}`);
    await mkdir(join(dir, "apps", "web"), { recursive: true });
    await mkdir(join(dir, "services", "api", "tests"), { recursive: true });
    await mkdir(join(dir, "services", "worker"), { recursive: true });
    await mkdir(join(dir, "crates", "tool"), { recursive: true });
    await writeFile(
      join(dir, "apps", "web", "package.json"),
      JSON.stringify({
        packageManager: "pnpm@10.33.0",
        scripts: {
          build: "vite build",
          test: "vitest run"
        }
      }),
      "utf8"
    );
    await writeFile(join(dir, "services", "api", "requirements.txt"), "pytest\n", "utf8");
    await writeFile(join(dir, "services", "worker", "go.mod"), "module example.com/worker\n", "utf8");
    await writeFile(join(dir, "crates", "tool", "Cargo.toml"), "[package]\nname='tool'\nversion='0.1.0'\nedition='2021'\n", "utf8");

    const steps = await new Verifier().detect(dir);

    expect(steps).toEqual([
      { name: "apps/web pnpm install", command: ["pnpm", "install"], cwd: "apps/web", required: true },
      { name: "apps/web pnpm build", command: ["pnpm", "run", "build"], cwd: "apps/web", required: true },
      { name: "apps/web pnpm test", command: ["pnpm", "run", "test"], cwd: "apps/web", required: true },
      {
        name: "services/api pip install requirements",
        command: ["python3", "-m", "pip", "install", "-r", "requirements.txt"],
        cwd: "services/api",
        required: true
      },
      { name: "services/api pytest", command: ["python3", "-m", "pytest"], cwd: "services/api", required: true },
      { name: "services/worker go test", command: ["go", "test", "./..."], cwd: "services/worker", required: true },
      { name: "services/worker go build", command: ["go", "build", "./..."], cwd: "services/worker", required: true },
      { name: "crates/tool cargo test", command: ["cargo", "test"], cwd: "crates/tool", required: true },
      { name: "crates/tool cargo build", command: ["cargo", "build"], cwd: "crates/tool", required: true }
    ]);
  });

  it("runs nested verification commands from the nested project directory", async () => {
    const dir = join(tmpdir(), `kakashi-verifier-${randomUUID()}`);
    await mkdir(join(dir, "apps", "web"), { recursive: true });
    await writeFile(
      join(dir, "apps", "web", "package.json"),
      JSON.stringify({
        scripts: {
          test: "node -e \"process.exit(process.cwd().endsWith('apps/web') ? 0 : 9)\""
        }
      }),
      "utf8"
    );

    const result = await new Verifier().verify(dir, 30_000);

    expect(result.ok).toBe(true);
    expect(result.steps.map((step) => step.name)).toEqual(["apps/web npm install", "apps/web npm test"]);
    expect(result.steps.at(-1)?.result.cwd).toBe(join(dir, "apps", "web"));
  });

  it("uses editable Python installs when only pyproject.toml is present", async () => {
    const dir = join(tmpdir(), `kakashi-verifier-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "pyproject.toml"), "[project]\nname='kakashi'\nversion='0.0.1'\n", "utf8");

    await expect(new Verifier().detect(dir)).resolves.toEqual([
      { name: "pip install editable", command: ["python3", "-m", "pip", "install", "-e", "."], required: true }
    ]);
  });

  it("reports unsupported projects as unverifiable", async () => {
    const dir = join(tmpdir(), `kakashi-verifier-${randomUUID()}`);
    await mkdir(dir, { recursive: true });

    const result = await new Verifier().verify(dir, 5_000);

    expect(result.ok).toBe(false);
    expect(result.steps).toEqual([]);
    expect(result.summary).toMatch(/No supported project manifest/);
  });

  it("fails verification at the first required command failure", async () => {
    const dir = join(tmpdir(), `kakashi-verifier-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        scripts: {
          test: "node -e \"process.exit(3)\"",
          build: "node -e \"console.log('should not run after failed test')\""
        }
      }),
      "utf8"
    );

    const result = await new Verifier().verify(dir, 30_000);

    expect(result.ok).toBe(false);
    expect(result.summary).toBe("Verification failed at npm test.");
    expect(result.steps.map((step) => step.name)).toEqual(["npm install", "npm build", "npm test"]);
    expect(result.steps.at(-1)?.result.exitCode).toBe(3);
  });
});

async function getOpenPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  server.close();
  await once(server, "close");
  if (!address || typeof address === "string") throw new Error("Could not allocate a local port.");
  return address.port;
}
