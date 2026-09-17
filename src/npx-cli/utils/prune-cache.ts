import { existsSync, readdirSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { pluginCacheRootDirectory } from './paths.js';
import { compareVersionsDescending, workerHttpRequest } from '../../shared/worker-utils.js';

/**
 * Versions of the plugin cache to keep: the newly installed one (N) and the
 * previous one (N-1). Everything older is a superseded worker source that
 * nothing resolves to any more, so it only wastes disk and stays a runnable
 * old-version worker (the mechanism behind #3736 and #3446). See #4105.
 */
export const DEFAULT_CACHE_RETENTION = 2;

/** A cache directory name is a version when it starts with a digit — the same
 * filter the worker-script resolver uses (cacheWorkerScriptCandidates). */
function isVersionDirectoryName(name: string): boolean {
  return /^\d/.test(name);
}

export interface CachePrunePlan {
  /** Versions retained: the newest `keepCount`, plus any protected version. */
  keep: string[];
  /** Versions to delete, newest-first. */
  prune: string[];
}

/**
 * Decide which cache versions to keep and which to prune. Pure: no disk access.
 *
 * Keeps the newest `keepCount` versions by the shared descending order, plus
 * every version in `protectedVersions` (the live worker's version, so a prune
 * never removes the directory a running worker was launched from). Names that
 * are not version directories are ignored — never pruned.
 */
export function planCachePrune(
  versionDirectoryNames: string[],
  keepCount: number,
  protectedVersions: Iterable<string> = [],
): CachePrunePlan {
  const ordered = versionDirectoryNames
    .filter(isVersionDirectoryName)
    .sort(compareVersionsDescending);
  const protectedSet = new Set(protectedVersions);

  const keep: string[] = [];
  const prune: string[] = [];
  ordered.forEach((version, index) => {
    if (index < keepCount || protectedSet.has(version)) {
      keep.push(version);
    } else {
      prune.push(version);
    }
  });
  return { keep, prune };
}

export interface CachePruneResult {
  root: string;
  kept: string[];
  removed: string[];
  failed: { version: string; reason: string }[];
}

/** List the version-directory names under a cache root, best-effort. Returns
 * an empty list when the root is absent or unreadable. */
export function readCacheVersionDirectories(root: string): string[] {
  try {
    return readdirSync(root).filter(name => {
      try {
        return statSync(join(root, name)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

export interface PrunePluginCacheOptions {
  cacheRoot?: string;
  keepCount?: number;
  protectedVersions?: Iterable<string>;
}

/**
 * Remove superseded plugin cache versions, keeping the newest `keepCount` and
 * any protected version. Best-effort: a directory that cannot be removed (for
 * example a live worker's files locked on Windows) is reported in `failed`
 * rather than aborting the caller.
 */
export function prunePluginCache(options: PrunePluginCacheOptions = {}): CachePruneResult {
  const root = options.cacheRoot ?? pluginCacheRootDirectory();
  const keepCount = options.keepCount ?? DEFAULT_CACHE_RETENTION;

  const names = readCacheVersionDirectories(root);
  const { keep, prune } = planCachePrune(names, keepCount, options.protectedVersions);
  const removed: string[] = [];
  const failed: { version: string; reason: string }[] = [];
  for (const version of prune) {
    try {
      rmSync(join(root, version), { recursive: true, force: true });
      removed.push(version);
    } catch (error: unknown) {
      failed.push({ version, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { root, kept: keep, removed, failed };
}

/**
 * Best-effort read of the version the live worker self-reports on
 * GET /api/health. Returns null when no worker is reachable, so a prune run
 * with no worker up simply falls back to the keep-newest rule.
 */
export async function fetchLiveWorkerVersion(): Promise<string | null> {
  try {
    const response = await workerHttpRequest('/api/health', { timeoutMs: 2000 });
    const body = await response.json() as { version?: unknown };
    return typeof body.version === 'string' ? body.version : null;
  } catch {
    return null;
  }
}

/**
 * Prune the cache while protecting whatever version the live worker reports, so
 * a standalone prune run can never pull the directory out from under a running
 * worker. Used by the `npx claude-mem prune` command.
 */
export async function prunePluginCacheProtectingLiveWorker(
  options: PrunePluginCacheOptions = {},
): Promise<CachePruneResult> {
  const liveVersion = await fetchLiveWorkerVersion();
  const protectedVersions = [
    ...(options.protectedVersions ?? []),
    ...(liveVersion ? [liveVersion] : []),
  ];
  return prunePluginCache({ ...options, protectedVersions });
}
