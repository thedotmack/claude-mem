/**
 * Precomputed SessionStart context (liveness plan, Phase 6).
 *
 * The worker renders the SessionStart block ahead of time, whenever something
 * that feeds it changes, and writes it here. The context hook reads the file and
 * returns without asking the worker anything, so a session starts with its
 * memory even while the worker is busy, restarting, or gone.
 *
 * The only parts of the block that depend on WHEN it is read are rendered as
 * placeholders and filled at read time by `fillContextPlaceholders`. The live
 * HTTP route fills the same body the same way, so a cached read and a live read
 * at the same instant are byte-identical.
 *
 * Hook-safe: no worker, database or renderer imports.
 */
import { createHash, randomBytes } from 'crypto';
import { existsSync, readdirSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { resolveDataDir } from './paths.js';
import { readJsonFileWithBom, writeJsonFileAtomic } from './atomic-json.js';
import { formatHeaderDateTime } from './timeline-formatting.js';
import { describeDuration } from './observer-health.js';
import { logger } from '../utils/logger.js';
import { workerData } from 'node:worker_threads';

/**
 * A cached block older than this is not served: the worker that keeps it fresh
 * has probably been dead for a day, so the hook takes the live path, which
 * starts the worker and renders from the database.
 */
export const CONTEXT_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Placeholders carry a per-process random nonce, so text that came from memory
 * (an observation quoting `⟦CMEM_...⟧`) is never mistaken for one: a fill only
 * replaces placeholders with the nonce the body was rendered under. The nonce
 * is stored with the cached file and never appears in filled output.
 */
const PLACEHOLDER_NONCE_PATTERN = /^[0-9a-f]{12}$/;
const inheritedNonce: unknown = workerData && typeof workerData === 'object' ? workerData.contextPlaceholderNonce : undefined;
if (inheritedNonce !== undefined && (typeof inheritedNonce !== 'string' || !PLACEHOLDER_NONCE_PATTERN.test(inheritedNonce))) {
  throw new Error('Invalid inherited context placeholder nonce');
}
export const CONTEXT_PLACEHOLDER_NONCE = typeof inheritedNonce === 'string' ? inheritedNonce : randomBytes(6).toString('hex');

/**
 * Blocks cached before the header became the one Rules + Tools line carry this
 * header-time placeholder. The worker re-renders every cached block when it
 * starts, so only a block read before the upgraded worker boots still has it;
 * it is filled so that read never shows a raw placeholder.
 */
function legacyHeaderTimePlaceholderFor(nonce: string): string {
  return `⟦CMEM_NOW_HEADER:${nonce}⟧`;
}

const RELATIVE_TIME_EPOCH_DIGITS = 13;

/**
 * Where an "updated N ago" duration goes, measured from `epochMs` to the read.
 * The epoch is zero-padded to 13 digits, so the placeholder (37 characters) is
 * never shorter than the duration it becomes ("about 115740741 days" is 20):
 * text fitted with placeholders still fits once filled.
 */
export function relativeTimePlaceholder(epochMs: number): string {
  const wholeEpochMs = Math.max(0, Math.trunc(epochMs));
  return `⟦CMEM_AGO:${CONTEXT_PLACEHOLDER_NONCE}:${String(wholeEpochMs).padStart(RELATIVE_TIME_EPOCH_DIGITS, '0')}⟧`;
}

/**
 * Turn a rendered body into what the reader sees at `nowEpochMs`. The one
 * function both the hook (cached body, with the file's nonce) and the worker's
 * live route (this process's nonce) use.
 */
export function fillContextPlaceholders(
  body: string,
  nowEpochMs: number,
  placeholderNonce: string = CONTEXT_PLACEHOLDER_NONCE,
): string {
  if (!PLACEHOLDER_NONCE_PATTERN.test(placeholderNonce)) {
    throw new Error(`Invalid context placeholder nonce: ${JSON.stringify(placeholderNonce)}`);
  }
  const headerTime = formatHeaderDateTime(new Date(nowEpochMs));
  const relativeTimePattern = new RegExp(`⟦CMEM_AGO:${placeholderNonce}:(\\d{${RELATIVE_TIME_EPOCH_DIGITS}})⟧`, 'g');
  return body
    .replaceAll(legacyHeaderTimePlaceholderFor(placeholderNonce), () => headerTime)
    .replace(relativeTimePattern, (_match, epochDigits: string) =>
      describeDuration(nowEpochMs - Number(epochDigits)));
}

/** What a cached block was rendered for; the same values the inject URL carries. */
export interface ContextCacheKeys {
  /** The project keys, in request order (primary last). */
  projects: string[];
  /** Normalized platform source, or 'all' when the request was not source-scoped. */
  platformSource: string;
  /** The colored terminal render (colors=true) rather than the model's block. */
  colors: boolean;
  /**
   * The host's directory, for the colored render only: its file headings are
   * relative to it. The model's block does not depend on it, so keying that on
   * cwd would split one checkout's cache by every directory a session starts in.
   */
  cwd?: string;
}

export const ALL_PLATFORM_SOURCES_CACHE_KEY = 'all';

/**
 * Keys for one request, normalized the way the worker parses `projects=`, so the
 * hook and the worker name a variant identically. `platformSource` must already
 * be normalized (normalizePlatformSource); undefined means every source.
 */
export function contextCacheKeys(
  projects: string[],
  platformSource: string | undefined,
  colors: boolean,
  cwd?: string,
): ContextCacheKeys {
  return {
    projects: projects.filter(project => project.trim().length > 0),
    platformSource: platformSource || ALL_PLATFORM_SOURCES_CACHE_KEY,
    colors,
    ...(colors && cwd ? { cwd } : {}),
  };
}

export function contextCacheDir(): string {
  return join(resolveDataDir(), 'state', 'context-cache');
}

function contextProjectCatalogPath(): string {
  return join(contextCacheDir(), 'project-catalog.json');
}

/**
 * The last project list the worker's catalog gave an all-project SessionStart
 * (CLAUDE_MEM_CONTEXT_PROJECTS=all), sorted. The hook keeps it so a cache hit
 * can name the all-project variant without asking the worker, and so a worker
 * outage still finds that variant (#6403). The worker rewrites it when a write
 * names a project it lacks (refreshContextProjectCatalog), so a stored list
 * never hides a new project behind an older variant the worker keeps fresh.
 * It holds project keys only, never paths. Null when there is none.
 */
export function readContextProjectCatalog(): string[] | null {
  const filePath = contextProjectCatalogPath();
  if (!existsSync(filePath)) return null;
  try {
    const projects = readJsonFileWithBom<unknown>(filePath);
    if (Array.isArray(projects) && projects.every(project => typeof project === 'string')) return projects;
    logger.warn('HOOK', 'Stored SessionStart project catalog malformed; asking the worker', { filePath });
  } catch (error) {
    logger.warn('HOOK', 'Stored SessionStart project catalog unreadable; asking the worker', { filePath },
      error instanceof Error ? error : new Error(String(error)));
  }
  return null;
}

/** Store `projects`, sorted, as the catalog. Writes only when the list changed. */
export function saveContextProjectCatalog(projects: string[]): void {
  const sorted = [...projects].sort();
  if (JSON.stringify(readContextProjectCatalog()) === JSON.stringify(sorted)) return;
  try {
    writeJsonFileAtomic(contextProjectCatalogPath(), sorted);
  } catch (error) {
    // Only the cache-first read is lost: the next SessionStart asks the worker.
    logger.warn('HOOK', 'Could not save the SessionStart project catalog', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Worker side: a write touched these projects ('all' when it can change any).
 * Once a SessionStart has stored a catalog, a write naming a project the list
 * lacks, or touching all of them, stores the current list.
 */
export function refreshContextProjectCatalog(touchedProjects: string[] | 'all', listProjects: () => string[]): void {
  const stored = readContextProjectCatalog();
  if (!stored) return;
  if (touchedProjects !== 'all' && touchedProjects.every(project => stored.includes(project))) return;
  saveContextProjectCatalog(listProjects());
}

export function contextCacheVariantId(keys: ContextCacheKeys): string {
  return createHash('sha256')
    .update(JSON.stringify([keys.projects, keys.platformSource, keys.colors, ...(keys.colors && keys.cwd ? [keys.cwd] : [])]))
    .digest('hex');
}

export function contextCacheFilePath(keys: ContextCacheKeys): string {
  return join(contextCacheDir(), `${contextCacheVariantId(keys)}.json`);
}

export interface CachedContextFile {
  body: string;
  renderedAtEpochMs: number;
  keys: ContextCacheKeys;
  /** The nonce `body`'s placeholders were rendered with (the writing worker's). */
  placeholderNonce: string;
}

/** `body` must have been rendered in this process (its placeholders carry this process's nonce). */
export function writeContextCache(keys: ContextCacheKeys, body: string, renderedAtEpochMs: number): void {
  const file: CachedContextFile = { body, renderedAtEpochMs, keys, placeholderNonce: CONTEXT_PLACEHOLDER_NONCE };
  writeJsonFileAtomic(contextCacheFilePath(keys), file);
}

export function removeContextCache(keys: ContextCacheKeys): void {
  const filePath = contextCacheFilePath(keys);
  if (existsSync(filePath)) unlinkSync(filePath);
}

/**
 * The cached body for `keys`, or null when there is none to serve: no file,
 * older than CONTEXT_CACHE_MAX_AGE_MS, unreadable, or written for other keys.
 * Null means "take the live path"; it never hides an error from the caller's
 * point of view, because the live path is the pre-cache behavior.
 */
export function readContextCache(keys: ContextCacheKeys, nowEpochMs: number): CachedContextFile | null {
  const filePath = contextCacheFilePath(keys);
  if (!existsSync(filePath)) return null;
  let parsed: Partial<CachedContextFile>;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as Partial<CachedContextFile>;
  } catch (error) {
    logger.warn('HOOK', 'Context cache file unreadable; using the live path', { filePath },
      error instanceof Error ? error : new Error(String(error)));
    return null;
  }
  if (typeof parsed.body !== 'string' || typeof parsed.renderedAtEpochMs !== 'number' || !parsed.keys
    || typeof parsed.placeholderNonce !== 'string' || !PLACEHOLDER_NONCE_PATTERN.test(parsed.placeholderNonce)) {
    logger.warn('HOOK', 'Context cache file malformed; using the live path', { filePath });
    return null;
  }
  if (nowEpochMs - parsed.renderedAtEpochMs > CONTEXT_CACHE_MAX_AGE_MS) {
    logger.debug('HOOK', 'Context cache older than the staleness limit; using the live path', {
      filePath,
      renderedAtEpochMs: parsed.renderedAtEpochMs,
    });
    return null;
  }
  if (contextCacheVariantId(parsed.keys) !== contextCacheVariantId(keys)) {
    logger.warn('HOOK', 'Context cache file written for other keys; using the live path', { filePath });
    return null;
  }
  return parsed as CachedContextFile;
}

/** File names of every cached block in the cache dir (not the index, not temp files). */
export function listContextCacheFiles(): string[] {
  const dir = contextCacheDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => /^[0-9a-f]{64}\.json$/.test(name));
}
