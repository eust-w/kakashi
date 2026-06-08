import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function readJsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function writeJsonFile(path: string, data: unknown): Promise<void> {
  await ensureDir(dirname(path));
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export async function emptyDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
  await ensureDir(path);
}

export async function isDirectoryEmpty(path: string): Promise<boolean> {
  if (!(await pathExists(path))) return true;
  const entries = await readdir(path);
  return entries.length === 0;
}

export async function findFirstExisting(baseDir: string, names: string[]): Promise<string | null> {
  for (const name of names) {
    const candidate = join(baseDir, name);
    if (await pathExists(candidate)) return candidate;
  }
  return null;
}

