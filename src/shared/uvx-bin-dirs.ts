import fs from 'fs';
import os from 'os';
import path from 'path';

export interface UvxBinDirOptions {
  override?: string;
  homedir?: () => string;
  platform?: NodeJS.Platform;
  isFile?: (filePath: string) => boolean;
}

function defaultIsFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function getUvxBinDirs(options: UvxBinDirOptions = {}): string[] {
  const override = options.override ?? process.env.CLAUDE_MEM_CHROMA_UVX_PATH;
  const homedir = options.homedir ?? os.homedir;
  const platform = options.platform ?? process.platform;
  const isFile = options.isFile ?? defaultIsFile;
  const home = homedir();
  const dirs = [
    override,
    path.join(home, '.local', 'bin'),
    path.join(home, '.cargo', 'bin'),
    ...(platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin'] : []),
  ].filter((dir): dir is string => Boolean(dir));

  return dirs.map(dir => isFile(dir) ? path.dirname(dir) : dir);
}
