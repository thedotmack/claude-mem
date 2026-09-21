import { existsSync, readdirSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { pluginCacheRootDirectory } from './paths.js';
import { compareVersionsDescending, workerHttpRequest } from '../../shared/worker-utils.js';
import { readOwnedWorkerPidInfo } from '../../supervisor/index.js';
import { verifyPidFileOwnership } from '../../supervisor/process-registry.js';

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

/** True when a cache version directory carries Claude Code's `.orphaned_at`
 * marker. The worker-script resolver skips these, so they are never a live
 * install and must not count toward the retention budget. */
function isOrphanedVersion(root: string, name: string): boolean {
  return existsSync(join(root, name, '.orphaned_at'));
}

export interface CachePrunePlan {
  /** Versions retained: the newest usable `keepCount`, plus any protected version. */
  keep: string[];
  /** Versions to delete, newest-first. */
  prune: string[];
}

export interface PlanCachePruneOptions {
  /** Versions never pruned (for example the live worker's version). */
  protectedVersions?: Iterable<string>;
  /** Versions marked `.orphaned_at`: never counted toward retention, always
   * prunable unless also protected. */
  orphanedVersions?: Iterable<string>;
}

/**
 * Decide which cache versions to keep and which to prune. Pure: no disk access.
 *
 * Retention counts only usable (non-orphaned) versions, so an orphaned newest
 * directory never displaces a usable rollback version (#4105 review). Keeps the
 * newest `keepCount` usable versions plus every protected version; prunes the
 * rest, including orphaned directories that are not protected.
 */
export function planCachePrune(
  versionDirectoryNames: string[],
  keepCount: number,
  options: PlanCachePruneOptions = {},
): CachePrunePlan {
  const protectedSet = new Set(options.protectedVersions);
  const orphanedSet = new Set(options.orphanedVersions);

  const versions = versionDirectoryNames
    .filter(isVersionDirectoryName)
    .sort(compareVersionsDescending);

  const usable = versions.filter(version => !orphanedSet.has(version));
  const retained = new Set(usable.slice(0, keepCount));

  const keep: string[] = [];
  const prune: string[] = [];
  for (const version of versions) {
    if (retained.has(version) || protectedSet.has(version)) {
      keep.push(version);
    } else {
      prune.push(version);
    }
  }
  return { keep, prune };
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

export interface CachePruneResult {
  root: string;
  kept: string[];
  removed: string[];
  failed: { version: string; reason: string }[];
  /** True when pruning was skipped because a live worker's version could not be
   * determined, so every version was retained for safety. */
  retainedForLiveWorker: boolean;
}

export interface PrunePluginCacheOptions {
  cacheRoot?: string;
  keepCount?: number;
  protectedVersions?: Iterable<string>;
}

/** Read the version names and their `.orphaned_at` state, then plan the prune.
 * Read-only — use for a dry-run preview that matches what `prunePluginCache`
 * would delete. */
export function planPluginCachePrune(
  root: string,
  keepCount: number,
  protectedVersions: Iterable<string> = [],
): CachePrunePlan {
  const names = readCacheVersionDirectories(root);
  const orphanedVersions = names.filter(name => isVersionDirectoryName(name) && isOrphanedVersion(root, name));
  return planCachePrune(names, keepCount, { protectedVersions, orphanedVersions });
}

/**
 * Remove superseded plugin cache versions, keeping the newest usable `keepCount`
 * and any protected version. Best-effort: a directory that cannot be removed
 * (for example a live worker's files locked on Windows) is reported in `failed`
 * rather than aborting the caller.
 *
 * This does not itself protect a running worker — callers that may run while a
 * worker is live must pass the live version in `protectedVersions`, or use
 * `prunePluginCacheSafely`.
 */
export function prunePluginCache(options: PrunePluginCacheOptions = {}): CachePruneResult {
  const root = options.cacheRoot ?? pluginCacheRootDirectory();
  const keepCount = options.keepCount ?? DEFAULT_CACHE_RETENTION;

  const { keep, prune } = planPluginCachePrune(root, keepCount, options.protectedVersions ?? []);
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
  return { root, kept: keep, removed, failed, retainedForLiveWorker: false };
}

export type LiveWorkerProbe =
  /** The worker answered with a usable version. */
  | { status: 'version'; version: string }
  /** A worker is present but its version cannot be read (timed out, or a
   * malformed body). Pruning must retain every version. */
  | { status: 'reachable-unknown' }
  /** Nothing is answering on the worker port. */
  | { status: 'unreachable' };

/**
 * Probe the worker's health endpoint and classify the result. A usable version
 * lets a prune protect exactly that directory; a present-but-unreadable worker
 * forces a full retention; an unreachable port leaves protection to the PID
 * check in `resolveWorkerProtection`.
 */
export async function probeLiveWorker(): Promise<LiveWorkerProbe> {
  let response: Response;
  try {
    response = await workerHttpRequest('/api/health', { timeoutMs: 2000 });
  } catch (error: unknown) {
    // fetchWithTimeout rethrows a timeout as an Error whose message contains
    // "timed out"; anything with that shape means a worker may be alive but
    // hung, so we must not prune its source. Every other failure (connection
    // refused, DNS) means nothing is listening.
    const message = error instanceof Error ? error.message : String(error);
    return /timed out/i.test(message) ? { status: 'reachable-unknown' } : { status: 'unreachable' };
  }

  let body: { version?: unknown };
  try {
    body = await response.json() as { version?: unknown };
  } catch {
    return { status: 'reachable-unknown' };
  }
  if (typeof body.version === 'string' && body.version.length > 0) {
    return { status: 'version', version: body.version };
  }
  return { status: 'reachable-unknown' };
}

export interface WorkerProtection {
  protectedVersions: string[];
  /** When true, no prune may delete anything: a worker is running but its
   * version is unknown, so we cannot tell which directory to keep. */
  retainAll: boolean;
}

/**
 * Decide how a prune must protect a running worker. A readable version protects
 * exactly that directory. A present-but-unreadable worker (hung health, or a
 * live PID with a silent port) forces a full retention. Only when nothing is
 * running is a prune free to delete superseded versions.
 */
export async function resolveWorkerProtection(): Promise<WorkerProtection> {
  const probe = await probeLiveWorker();
  if (probe.status === 'version') {
    return { protectedVersions: [probe.version], retainAll: false };
  }
  if (probe.status === 'reachable-unknown') {
    return { protectedVersions: [], retainAll: true };
  }
  // Port silent — confirm no worker process is alive before deleting anything.
  const workerAlive = verifyPidFileOwnership(readOwnedWorkerPidInfo());
  return { protectedVersions: [], retainAll: workerAlive };
}

export interface PrunePluginCacheSafelyOptions {
  cacheRoot?: string;
  keepCount?: number;
  /** Versions to protect in addition to the live worker's (for example the
   * version an installer just wrote). */
  additionalProtectedVersions?: Iterable<string>;
}

/**
 * Prune the cache while protecting a running worker. When the worker's version
 * cannot be determined but a worker is present, every version is retained so a
 * prune can never pull the source directory out from under a live process. Used
 * by both the installer and the `npx claude-mem prune` command.
 */
export async function prunePluginCacheSafely(
  options: PrunePluginCacheSafelyOptions = {},
): Promise<CachePruneResult> {
  const root = options.cacheRoot ?? pluginCacheRootDirectory();
  const { protectedVersions, retainAll } = await resolveWorkerProtection();

  if (retainAll) {
    const kept = readCacheVersionDirectories(root).filter(isVersionDirectoryName);
    return { root, kept, removed: [], failed: [], retainedForLiveWorker: true };
  }

  return prunePluginCache({
    cacheRoot: root,
    keepCount: options.keepCount,
    protectedVersions: [...(options.additionalProtectedVersions ?? []), ...protectedVersions],
  });
}
