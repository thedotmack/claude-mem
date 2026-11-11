import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'fs';
import { rm } from 'fs/promises';
import path, { basename, isAbsolute, join, relative, resolve, sep } from 'path';
import { installedPluginsPath, pluginCacheRootDirectory } from './paths.js';
import {
  cacheWorkerScriptCandidates,
  compareVersionsDescending,
  resolveWorkerScript,
  selectWorkerScript,
  workerHttpRequest,
  type WorkerScriptCandidate,
} from '../../shared/worker-utils.js';
import { readOwnedWorkerPidInfo } from '../../supervisor/process-registry.js';
import { readClaudeMemRegistrationEntries, readUserScopeClaudeMemInstallPaths, registeredInstallPathsOf } from '../../shared/claude-code-plugin-paths.js';

/**
 * Versions of the plugin cache to keep: the newly installed one (N) and the
 * previous one (N-1). Everything older is a superseded worker source that
 * nothing resolves to any more, so it only wastes disk and stays a runnable
 * old-version worker (the mechanism behind #3736 and #3446). See #4105.
 * Claude Code's marketplace update writes the next folder itself and never
 * runs that copy, so the worker sweeps the same cache (#5681).
 */
export const DEFAULT_CACHE_RETENTION = 2;

/** How long the worker waits after boot before the first cache sweep, and how
 * often it repeats. A daemon stays up across later marketplace updates. */
export const PLUGIN_CACHE_PRUNE_FIRST_DELAY_MS = 5 * 60_000;
export const PLUGIN_CACHE_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/** A release folder name: 15.15.1 or 15.15.1-beta.1. Same shape as
 * INSTALLED_VERSION_PATTERN, kept local so this module does not import the
 * auto-update checker. Anything else under the cache (notes, another tool)
 * is left alone. */
const VERSION_DIRECTORY_NAME = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function isVersionDirectoryName(name: string): boolean {
  return VERSION_DIRECTORY_NAME.test(name);
}

/** True when a cache version directory carries Claude Code's `.orphaned_at`
 * marker. The worker-script resolver skips these, so they are never a live
 * install and must not count toward the retention budget. */
function isOrphanedVersion(root: string, name: string): boolean {
  return existsSync(join(root, name, '.orphaned_at'));
}

/**
 * How long an orphaned version folder stays on disk after it was replaced.
 *
 * Claude Code stamps `.orphaned_at` (epoch-ms) when a marketplace update
 * supersedes a folder, but a host session that is already running keeps loading
 * claude-mem from that folder. Deleting it makes every hook in that session fail
 * silently, and the session captures nothing at all (#5970). The marker's own
 * time is the retention clock, matching the 14-day clean-up the auto-updater
 * documents; a folder whose time cannot be read is kept rather than guessed at.
 */
export const ORPHANED_CACHE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * When a version folder was orphaned, in epoch ms. Prefers the epoch-ms value
 * the auto-updater writes into `.orphaned_at`; accepts epoch seconds and falls
 * back to the marker's mtime (Claude Code writes its own marker). Returns null
 * when nothing readable is there, which callers treat as "keep it".
 */
export function readOrphanedAtMs(root: string, name: string): number | null {
  const marker = join(root, name, '.orphaned_at');
  try {
    const value = Number(readFileSync(marker, 'utf-8').trim());
    if (Number.isInteger(value) && value >= 1e12) return value;
    if (Number.isInteger(value) && value >= 1e9) return value * 1000;
  } catch {
    // Unreadable marker: fall back to its mtime below.
  }
  try {
    return statSync(marker).mtimeMs;
  } catch {
    return null;
  }
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

/** The cache version directory `filePath` lives in, or null when it is outside `root`. */
function cacheVersionContaining(root: string, filePath: string): string | null {
  const pathFromRoot = relative(root, filePath);
  if (!pathFromRoot || pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) return null;
  const versionDirectory = pathFromRoot.split(sep)[0];
  return isVersionDirectoryName(versionDirectory) ? versionDirectory : null;
}

type PathApi = {
  relative: (from: string, to: string) => string;
  isAbsolute: (filePath: string) => boolean;
  sep: string;
};

/** True when `target` is exactly one path segment inside `root`. */
export function isDirectChildPath(root: string, target: string, pathApi: PathApi = path): boolean {
  const rel = pathApi.relative(root, target);
  if (rel === '' || rel === '.') return false;
  if (pathApi.isAbsolute(rel)) return false;
  if (rel === '..' || rel.startsWith(`..${pathApi.sep}`) || rel.startsWith('../')) return false;
  return !rel.includes(pathApi.sep) && !rel.includes('/');
}

function canonicalPath(filePath: string): string {
  const resolved = resolve(filePath);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * The cache version `scriptPath` is running from, after resolving symlinks
 * (macOS /tmp is /private/tmp). Null when the script is not inside this cache.
 */
export function cacheVersionOfScript(cacheRoot: string, scriptPath: string): string | null {
  return cacheVersionContaining(canonicalPath(cacheRoot), canonicalPath(scriptPath));
}

function pathIsInside(parent: string, child: string): boolean {
  const rel = relative(canonicalPath(parent), canonicalPath(child));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith('../') && !isAbsolute(rel));
}

/**
 * Directory we are willing to delete for `version`, or null.
 * A symlink is the link itself, so unlinking it leaves the target in place.
 * A real directory is returned only when its resolved path is still that
 * one child of the cache root.
 */
export function versionDirectoryForRemoval(root: string, version: string): string | null {
  if (!isVersionDirectoryName(version)) return null;
  let rootReal: string;
  try {
    rootReal = realpathSync(resolve(root));
  } catch {
    return null;
  }
  const candidate = resolve(rootReal, version);
  if (!isDirectChildPath(rootReal, candidate)) return null;
  let info;
  try {
    info = lstatSync(candidate);
  } catch {
    return null;
  }
  if (info.isSymbolicLink()) return candidate;
  if (!info.isDirectory()) return null;
  let targetReal: string;
  try {
    targetReal = realpathSync(candidate);
  } catch {
    return null;
  }
  if (!isDirectChildPath(rootReal, targetReal)) return null;
  return candidate;
}

/**
 * Cache versions a prune must keep so the install still has a worker to run.
 * Retention counts versions, not working ones, and the installer prunes right
 * after copying the new version, before its dependencies are installed, so
 * "the newest N" can be N copies that cannot start. Keep:
 * - the version resolveWorkerScript() picks when it resolves into this cache:
 *   it is what every launcher spawns;
 * - the newest cache version whose dependency closure is complete
 *   (selectWorkerScript over this cache), so the cache never loses its only
 *   working copy.
 */
export function workingCacheVersions(
  root: string,
  resolvedWorkerScript: WorkerScriptCandidate | null = resolveWorkerScript(),
): string[] {
  const versions = new Set<string>();
  const newestWorking = selectWorkerScript(cacheWorkerScriptCandidates(root))?.version;
  if (newestWorking) versions.add(newestWorking);
  const resolvedVersion = resolvedWorkerScript ? cacheVersionContaining(root, resolvedWorkerScript.scriptPath) : null;
  if (resolvedVersion) versions.add(resolvedVersion);
  return [...versions];
}

/** How to age orphaned folders in a prune plan. */
export interface PlanPluginCachePruneOptions {
  /** Epoch ms the orphaned markers are compared against. Defaults to now. */
  now?: number;
  /** Retention for an orphaned folder; defaults to ORPHANED_CACHE_RETENTION_MS. */
  orphanedRetentionMs?: number;
}

/**
 * Read the version names and their `.orphaned_at` state, then plan the prune.
 * Read-only — use for a dry-run preview that matches what `prunePluginCache`
 * would delete. The working versions (workingCacheVersions) are always kept, and
 * an orphaned folder is kept until ORPHANED_CACHE_RETENTION_MS has passed: a
 * session that started before the update still loads its hooks from it (#5970).
 */
export function planPluginCachePrune(
  root: string,
  keepCount: number,
  protectedVersions: Iterable<string> = [],
  options: PlanPluginCachePruneOptions = {},
): CachePrunePlan {
  const names = readCacheVersionDirectories(root);
  const orphanedVersions = names.filter(name => isVersionDirectoryName(name) && isOrphanedVersion(root, name));
  const now = options.now ?? Date.now();
  const retention = options.orphanedRetentionMs ?? ORPHANED_CACHE_RETENTION_MS;
  const stillLoadedBySessions = orphanedVersions.filter(version => {
    const orphanedAt = readOrphanedAtMs(root, version);
    return orphanedAt === null || now - orphanedAt < retention;
  });
  return planCachePrune(names, keepCount, {
    protectedVersions: [...protectedVersions, ...workingCacheVersions(root), ...stillLoadedBySessions],
    orphanedVersions,
  });
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
    const directory = versionDirectoryForRemoval(root, version);
    if (!directory) {
      if (existsSync(join(root, version))) {
        failed.push({ version, reason: 'skipped: not a version directory inside the plugin cache' });
      }
      continue;
    }
    try {
      rmSync(directory, { recursive: true, force: true });
      removed.push(version);
    } catch (error: unknown) {
      failed.push({ version, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { root, kept: keep, removed, failed, retainedForLiveWorker: false };
}

export interface PruneSupersededPluginCacheOptions {
  cacheRoot?: string;
  keepCount?: number;
  /** Script or directory this process is running from. That version folder is never deleted. */
  runningScriptPath?: string;
  /** Extra version names to keep, such as the worker's own package version. */
  additionalProtectedVersions?: Iterable<string>;
  /** installed_plugins.json. Defaults to Claude Code's registry. */
  registryPath?: string;
}

/**
 * Remove superseded plugin cache versions without asking the live worker.
 * The worker calls this on itself: a health probe against its own port can
 * time out during boot and then retain every folder (#5681). The running
 * script's folder is protected instead, along with whatever
 * installed_plugins.json registers. A corrupt registry throws before any
 * delete. A missing cache root removes nothing.
 */
export async function pruneSupersededPluginCache(
  options: PruneSupersededPluginCacheOptions = {},
): Promise<CachePruneResult> {
  const root = options.cacheRoot ?? pluginCacheRootDirectory();
  const keepCount = options.keepCount ?? DEFAULT_CACHE_RETENTION;
  const registered = readRegisteredCacheVersions(options.registryPath);
  const runningVersion = options.runningScriptPath ? cacheVersionOfScript(root, options.runningScriptPath) : null;
  const protectedVersions = [
    ...(runningVersion ? [runningVersion] : []),
    ...registered,
    ...(options.additionalProtectedVersions ?? []),
  ];

  const { keep, prune } = planPluginCachePrune(root, keepCount, protectedVersions);
  const removed: string[] = [];
  const failed: { version: string; reason: string }[] = [];
  for (const version of prune) {
    const directory = versionDirectoryForRemoval(root, version);
    if (!directory) {
      if (existsSync(join(root, version))) {
        failed.push({ version, reason: 'skipped: not a version directory inside the plugin cache' });
      }
      continue;
    }
    if (options.runningScriptPath && pathIsInside(directory, options.runningScriptPath)) {
      failed.push({ version, reason: 'skipped: this is the running worker directory' });
      continue;
    }
    try {
      await rm(directory, { recursive: true, force: true });
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
 * check in `resolvePruneProtection`.
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

/**
 * Cache version directories that Claude Code's installed_plugins.json registers
 * for claude-mem (the basename of each `installPath`). The registered install is
 * what Claude Code loads, so a prune must never delete it — after a downgrade
 * with the worker stopped it can be older than the newest `keepCount`. A name
 * that is not in the cache (a marketplace installPath) protects nothing.
 * Throws on a corrupt registry, before anything is deleted.
 */
export function readRegisteredCacheVersions(registryPath: string = installedPluginsPath()): string[] {
  return registeredInstallPathsOf(readClaudeMemRegistrationEntries(registryPath)).map(installPath => basename(installPath));
}

/**
 * The cache version directories of the one registration the npx installer
 * writes, and every `npx claude-mem update` replaces (install.ts
 * registerPlugin): claude-mem@thedotmack's user-scope entries. Claude Code can
 * also hold project- or local-scope entries for claude-mem, each at a version
 * of its own, which no npx run writes; the auto-updater reads only this one,
 * so another scope's version never reads as the install having moved
 * (auto-update-check.ts, auto-update-launch.ts readInstallVersions). Throws on
 * a corrupt registry, as readRegisteredCacheVersions does.
 */
export function readUserScopeRegisteredCacheVersions(registryPath: string = installedPluginsPath()): string[] {
  return readUserScopeClaudeMemInstallPaths(registryPath).map(installPath => basename(installPath));
}

export interface PruneProtection {
  /** Versions no prune may delete: the live worker's and the registered install's. */
  protectedVersions: string[];
  /** When true, no prune may delete anything: a worker is running but its
   * version is unknown, so we cannot tell which directory to keep. */
  retainAll: boolean;
}

/**
 * Decide what a prune must protect. The registered install is always protected.
 * A live worker's readable version protects exactly that directory. A
 * present-but-unreadable worker (hung health, or a live PID with a silent port)
 * forces a full retention. Only when nothing is running is a prune free to
 * delete superseded versions.
 */
export async function resolvePruneProtection(): Promise<PruneProtection> {
  const registeredVersions = readRegisteredCacheVersions();
  const probe = await probeLiveWorker();
  if (probe.status === 'version') {
    return { protectedVersions: [probe.version, ...registeredVersions], retainAll: false };
  }
  if (probe.status === 'reachable-unknown') {
    return { protectedVersions: registeredVersions, retainAll: true };
  }
  // Port silent — confirm no worker process is alive before deleting anything.
  return { protectedVersions: registeredVersions, retainAll: readOwnedWorkerPidInfo() !== null };
}

export interface PrunePluginCacheSafelyOptions {
  cacheRoot?: string;
  keepCount?: number;
  /** Versions to protect in addition to the live worker's (for example the
   * version an installer just wrote). */
  additionalProtectedVersions?: Iterable<string>;
}

/**
 * Prune the cache while protecting a running worker and the registered install.
 * When the worker's version cannot be determined but a worker is present, every
 * version is retained so a prune can never pull the source directory out from
 * under a live process. Used by both the installer and the `npx claude-mem
 * prune` command.
 */
export async function prunePluginCacheSafely(
  options: PrunePluginCacheSafelyOptions = {},
): Promise<CachePruneResult> {
  const root = options.cacheRoot ?? pluginCacheRootDirectory();
  const { protectedVersions, retainAll } = await resolvePruneProtection();

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
