import { isAbsolute, relative, resolve } from "node:path";

export function resolveOutputDirInsideWorkDir(workDir: string, outputDir: string): string {
  const root = resolve(workDir);
  const resolved = resolve(root, outputDir);
  const relativePath = relative(root, resolved);
  if (!relativePath) {
    throw new Error(`Output directory must not be the server work directory itself: ${root}`);
  }
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`Output directory must be inside the server work directory: ${root}`);
  }
  return resolved;
}
