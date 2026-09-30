import fs from 'fs';
import os from 'os';
import path from 'path';

export interface UvxBinDirOptions {
  override?: string;
  homedir?: () => string;
  platform?: NodeJS.Platform;
  isFile?: (filePath: string) => boolean;
  env?: Record<string, string | undefined>;
}

function defaultIsFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * Directories the astral uv installer can place `uv`/`uvx` in, honouring the
 * env vars the installer itself consults: the first of `UV_INSTALL_DIR`,
 * `XDG_BIN_HOME`, `XDG_DATA_HOME/../bin`, then `$HOME/.local/bin`. Hard-coding
 * only `~/.local/bin` and `~/.cargo/bin` missed every env-directed install.
 */
export function getUvxBinDirs(options: UvxBinDirOptions = {}): string[] {
  const env = options.env ?? process.env;
  const override = options.override ?? env.CLAUDE_MEM_CHROMA_UVX_PATH;
  const homedir = options.homedir ?? os.homedir;
  const platform = options.platform ?? process.platform;
  const isFile = options.isFile ?? defaultIsFile;
  const home = homedir();

  const xdgDataBin = env.XDG_DATA_HOME
    ? path.join(env.XDG_DATA_HOME, '..', 'bin')
    : undefined;

  const dirs = [
    override,
    env.UV_INSTALL_DIR,
    env.XDG_BIN_HOME,
    xdgDataBin,
    path.join(home, '.local', 'bin'),
    path.join(home, '.cargo', 'bin'),
    // Linux `/usr/local/bin` and `/usr/bin` are omitted on purpose — they are
    // already on PATH, so the caller's PATH lookup covers system-package uv.
    ...(platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin'] : []),
  ].filter((dir): dir is string => Boolean(dir));

  const resolved = dirs.map(dir => isFile(dir) ? path.dirname(dir) : dir);
  return [...new Set(resolved)];
}
