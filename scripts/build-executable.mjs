#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageJson = JSON.parse(await readFile(join(rootDir, "package.json"), "utf8"));
const rawVersion = process.env.RELEASE_VERSION || packageJson.version;
const version = rawVersion.startsWith("v") ? rawVersion.slice(1) : rawVersion;
const nodeVersion = process.env.KAKASHI_NODE_VERSION || process.versions.node;
const releaseDir = join(rootDir, "dist", "executables");
const workDir = join(releaseDir, ".work");
const targets = parseTargets(process.argv.slice(2));

await rm(workDir, { recursive: true, force: true });
await mkdir(workDir, { recursive: true });
await mkdir(releaseDir, { recursive: true });

run("pnpm", ["build"]);

const webAssets = await collectWebAssets(join(rootDir, "apps", "web", "dist"));
const generatedDir = join(workDir, "generated");
await mkdir(generatedDir, { recursive: true });
const embeddedAssetsPath = join(generatedDir, "embedded-web-assets.ts");
const entryPath = join(generatedDir, "executable-entry.ts");
await writeFile(
  embeddedAssetsPath,
  `export const EMBEDDED_WEB_ASSETS = ${JSON.stringify(webAssets, null, 2)} as const;\n`,
  "utf8"
);
await writeFile(
  entryPath,
  [
    `import { setEmbeddedWebAssets } from "../../../../apps/cli/src/runtime-web-assets";`,
    `import { EMBEDDED_WEB_ASSETS } from "./embedded-web-assets";`,
    "",
    "setEmbeddedWebAssets(EMBEDDED_WEB_ASSETS);",
    `import("../../../../apps/cli/src/index").catch((error: unknown) => {`,
    `  console.error(error instanceof Error ? error.message : String(error));`,
    `  process.exitCode = 1;`,
    `});`,
    ""
  ].join("\n"),
  "utf8"
);

const bundlePath = join(workDir, "kakashi-sea-main.cjs");
run("pnpm", [
  "exec",
  "esbuild",
  entryPath,
  "--bundle",
  "--platform=node",
  "--target=node24",
  "--format=cjs",
  "--log-override:empty-import-meta=silent",
  `--outfile=${bundlePath}`
]);

const seaBlob = join(workDir, "kakashi-sea.blob");
const seaConfig = join(workDir, "sea-config.json");
await writeFile(
  seaConfig,
  `${JSON.stringify(
    {
      main: bundlePath,
      output: seaBlob,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false
    },
    null,
    2
  )}\n`,
  "utf8"
);
run(process.execPath, ["--experimental-sea-config", seaConfig]);

const built = [];
for (const targetName of targets) {
  const target = targetConfig(targetName);
  const nodeExecutable = await getNodeExecutable(target);
  const outputName = `kakashi-v${version}-${targetName}${target.platform === "windows" ? ".exe" : ""}`;
  const outputPath = join(releaseDir, outputName);
  await cp(nodeExecutable, outputPath);
  if (target.platform !== "windows") await chmod(outputPath, 0o755);

  const injectArgs = [
    outputPath,
    "NODE_SEA_BLOB",
    seaBlob,
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"
  ];
  if (target.platform === "darwin") {
    injectArgs.push("--macho-segment-name", "NODE_SEA");
  }
  run("pnpm", ["exec", "postject", ...injectArgs]);

  if (target.platform === "darwin" && commandExists("codesign")) {
    run("codesign", ["--sign", "-", outputPath]);
  }

  built.push(outputPath);
  console.log(`built ${outputPath}`);
}

const checksums = [];
for (const file of built) {
  const data = await readFile(file);
  checksums.push(`${createHash("sha256").update(data).digest("hex")}  ${basename(file)}`);
}
if (checksums.length > 0) {
  await writeFile(join(releaseDir, "SHA256SUMS-executables.txt"), `${checksums.join("\n")}\n`, "utf8");
}

function parseTargets(args) {
  const requested = args.filter((arg) => arg.startsWith("--target=")).map((arg) => arg.split("=")[1]).filter(Boolean);
  if (requested.length > 0) return requested;
  return [`${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`];
}

function targetConfig(name) {
  const [platform, arch] = name.split("-");
  if (!["linux", "darwin", "windows"].includes(platform) || !["x64", "arm64"].includes(arch)) {
    throw new Error(`Unsupported executable target: ${name}`);
  }
  return { name, platform, arch };
}

async function getNodeExecutable(target) {
  if (isHostTarget(target) && nodeVersion === process.versions.node && existsSync(process.execPath)) {
    console.log(`use local Node runtime ${process.execPath}`);
    return process.execPath;
  }

  const platform = target.platform === "windows" ? "win" : target.platform;
  const archiveExt = target.platform === "windows" ? "zip" : "tar.gz";
  const packageName = `node-v${nodeVersion}-${platform}-${target.arch}`;
  const archivePath = join(workDir, `${packageName}.${archiveExt}`);
  const extractDir = join(workDir, "node-runtimes");
  const executable = join(
    extractDir,
    packageName,
    target.platform === "windows" ? "node.exe" : join("bin", "node")
  );

  if (!existsSync(executable)) {
    await mkdir(extractDir, { recursive: true });
    await download(`https://nodejs.org/dist/v${nodeVersion}/${packageName}.${archiveExt}`, archivePath);
    run("tar", ["-xf", archivePath, "-C", extractDir]);
  }
  return executable;
}

function isHostTarget(target) {
  const hostPlatform = process.platform === "win32" ? "windows" : process.platform;
  return target.platform === hostPlatform && target.arch === process.arch;
}

async function download(url, destination) {
  console.log(`download ${url}`);
  await mkdir(dirname(destination), { recursive: true });
  run("curl", [
    "--fail",
    "--location",
    "--retry",
    "5",
    "--retry-delay",
    "2",
    "--retry-all-errors",
    "--connect-timeout",
    "20",
    "--speed-limit",
    "1024",
    "--speed-time",
    "30",
    "--output",
    destination,
    url
  ]);
}

async function collectWebAssets(webDir) {
  const assets = {};
  await walk(webDir, async (path) => {
    const fileStat = await stat(path);
    if (!fileStat.isFile()) return;
    const key = relative(webDir, path).split(sep).join("/");
    assets[key] = {
      contentType: contentTypeFor(path),
      contentBase64: (await readFile(path)).toString("base64")
    };
  });
  return assets;
}

async function walk(dir, visit) {
  for (const entry of await readdir(dir)) {
    const path = join(dir, entry);
    const entryStat = await stat(path);
    if (entryStat.isDirectory()) {
      await walk(path, visit);
    } else {
      await visit(path);
    }
  }
}

function contentTypeFor(path) {
  switch (extname(path)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".ico":
      return "image/x-icon";
    default:
      return "application/octet-stream";
  }
}

function run(command, args) {
  execFileSync(command, args, {
    cwd: rootDir,
    stdio: "inherit",
    env: process.env
  });
}

function commandExists(command) {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
