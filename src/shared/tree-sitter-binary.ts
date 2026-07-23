import { statSync } from 'fs';
import { join } from 'path';

export function treeSitterBinaryCandidates(platform: string = process.platform): string[] {
  return platform === 'win32' ? ['tree-sitter.exe', 'tree-sitter'] : ['tree-sitter'];
}

function defaultIsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function selectTreeSitterBinary(
  pkgDir: string,
  platform: string = process.platform,
  isFile: (path: string) => boolean = defaultIsFile,
): string | null {
  return treeSitterBinaryCandidates(platform)
    .map((name) => join(pkgDir, name))
    .find((path) => isFile(path)) ?? null;
}
