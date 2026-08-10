import fs from 'fs';
import os from 'os';
import path from 'path';
import { logger } from '../utils/logger.js';

// uv materializes each ephemeral `uvx` environment in a `.tmpXXXXXX` scratch
// directory under <uv-cache>/builds-v0/. uv deletes that directory itself once
// the build finishes, but a force-kill mid-build gives it no chance to run the
// cleanup, so the scratch directory (a full chromadb/onnxruntime/grpcio tree,
// ~200MB) is orphaned. Nothing else removes them, so they accumulate to tens
// of GB across normal chroma-mcp reconnects (issue #3540).

const DEFAULT_MIN_AGE_MS = 60 * 60 * 1000;

export interface UvCacheOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homedir?: () => string;
}

/**
 * Resolve <uv-cache>/builds-v0 — the directory that holds uv's ephemeral build
 * scratch dirs. Follows uv's own cache-location rules: UV_CACHE_DIR wins, then
 * the platform default (%LOCALAPPDATA%\uv\cache on Windows, $XDG_CACHE_HOME/uv
 * or ~/.cache/uv elsewhere). Returns null when the location cannot be resolved.
 */
export function resolveUvBuildsDir(options: UvCacheOptions = {}): string | null {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homedir = options.homedir ?? os.homedir;

  let cacheDir: string | undefined;
  if (env.UV_CACHE_DIR) {
    cacheDir = env.UV_CACHE_DIR;
  } else if (platform === 'win32') {
    cacheDir = env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'uv', 'cache') : undefined;
  } else if (env.XDG_CACHE_HOME) {
    cacheDir = path.join(env.XDG_CACHE_HOME, 'uv');
  } else {
    cacheDir = path.join(homedir(), '.cache', 'uv');
  }

  return cacheDir ? path.join(cacheDir, 'builds-v0') : null;
}

/**
 * Remove stale `.tmp*` build scratch directories left behind by force-killed
 * uvx builds. Best-effort: skips directories younger than `minAgeMs` so a
 * concurrent worker's in-flight build is never deleted, and swallows every
 * filesystem error. Returns the number of directories removed.
 */
export async function sweepStaleUvBuildDirs(
  options: UvCacheOptions & { minAgeMs?: number } = {}
): Promise<number> {
  const buildsDir = resolveUvBuildsDir(options);
  if (!buildsDir) {
    return 0;
  }

  const minAgeMs = options.minAgeMs ?? DEFAULT_MIN_AGE_MS;

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(buildsDir, { withFileTypes: true });
  } catch {
    // No cache yet, or not readable — nothing to sweep.
    return 0;
  }

  const now = Date.now();
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('.tmp')) {
      continue;
    }
    const dirPath = path.join(buildsDir, entry.name);
    try {
      const stat = await fs.promises.stat(dirPath);
      if (now - stat.mtimeMs < minAgeMs) {
        continue;
      }
      await fs.promises.rm(dirPath, { recursive: true, force: true });
      removed += 1;
    } catch (error) {
      logger.debug('CHROMA_MCP', 'Failed to sweep stale uv build dir (best-effort)', {
        dirPath,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  if (removed > 0) {
    logger.info('CHROMA_MCP', `Swept ${removed} stale uv build dir(s)`, { buildsDir });
  }
  return removed;
}
