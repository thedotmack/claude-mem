/**
 * Shared authority for the opencode observer provider's own sub-sessions.
 *
 * The observer spawns `opencode run` for its LLM turns, and the claude-mem
 * OpenCode plugin reports every opencode session back to the worker — so an
 * observer sub-session would be observed again, spawning another `opencode
 * run`, ad infinitum. Three independent layers close that loop:
 *
 *   1. Prompt sentinel: every spawned prompt starts with PROMPT_SENTINEL, and
 *      session-init for such prompts is skipped (see isOpencodeObserverPrompt
 *      in utils/tag-stripping.ts, mirroring the Codex internal-prompt skip).
 *   2. Session archive: the fixed observer directory keeps observer-session.id
 *      with the one reused server-minted session id. Worker ingest skips every
 *      event whose contentSessionId embeds that id (isObserverContentSession).
 *   3. The plugin itself remembers sentinel sessions and posts nothing for
 *      them (src/integrations/opencode-plugin/core.ts).
 *
 * The Zen free-tier fingerprint rejects `--session <custom-id>` (create path)
 * and `--agent <custom>` with 403 FreeTierError, while plain runs, `--title`
 * and `-s <existing-server-minted-id>` (continue path) return 200 — verified
 * empirically 2026-10-12. So reuse passes only `-s <archived-id>`, and there
 * is no custom zero-tool agent: tool silence comes from layers 1-3 plus a
 * "plain text only, no tools" instruction in the sentinel line.
 *
 * Session lifecycle (user constraints): one fixed directory, one reused
 * session (observer-session.id), rotation on reuse failure, cleanup before
 * each spawn (never the archived current, never a non-sentinel title).
 */

import { execFile } from 'node:child_process';
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { resolveDataDir, ensureDir } from '../../shared/paths.js';
import { OBSERVER_SESSION_TITLE, isObserverPromptSentinel } from '../../shared/observer-sentinel.js';
import { logger } from '../../utils/logger.js';

export const OBSERVER_ARCHIVE_FILENAME = 'observer-session.id';

/** Cleanup keeps the newest this many sentinel sessions (plus the current one, always). */
export const OBSERVER_KEEP_RECENT_COUNT = 5;
/** Cleanup also drops sentinel sessions older than this, even within the count. */
export const OBSERVER_KEEP_RECENT_DAYS = 7;

const SERVER_SESSION_ID_RE = /^ses_[A-Za-z0-9]+$/;

/** The one fixed directory every observer sub-session starts in. */
export function observerDir(): string {
  const dir = join(resolveDataDir(), 'opencode-observer');
  ensureDir(dir);
  return dir;
}

function archivePath(): string {
  return join(resolveDataDir(), 'opencode-observer', OBSERVER_ARCHIVE_FILENAME);
}

/** The reused server-minted session id, or null when none is archived (yet). */
export async function readArchivedSessionId(): Promise<string | null> {
  try {
    const raw = (await fs.readFile(archivePath(), 'utf8')).trim();
    return SERVER_SESSION_ID_RE.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

export async function writeArchivedSessionId(sessionId: string): Promise<void> {
  ensureDir(join(resolveDataDir(), 'opencode-observer'));
  await fs.writeFile(archivePath(), `${sessionId}\n`, 'utf8');
}

/**
 * Whether a worker contentSessionId belongs to the archived observer session.
 * The plugin mints `opencode-<sessionId>-<epoch>`, so the archived id is a
 * stable infix no matter how many prompts or service restarts happened.
 */
export async function isObserverContentSession(contentSessionId: string): Promise<boolean> {
  const archived = await readArchivedSessionId();
  return archived !== null && contentSessionId.startsWith(`opencode-${archived}-`);
}

/** Resolved `opencode` binary, cached. */
let cachedBinary: string | null | undefined;
export function resetOpencodeBinaryCacheForTesting(): void {
  cachedBinary = undefined;
}

function pickBinary(candidates: string[]): string | null {
  const valid = candidates.filter((c) => c && existsSync(c));
  if (valid.length === 0) return null;
  if (process.platform === 'win32') {
    // A pnpm/npm .cmd shim cannot receive cmd metacharacters (the observer
    // prompts are full of <xml>) — Node refuses the spawn outright. Peer
    // through the shim at the real .exe it delegates to (`@"<path>" %*`).
    for (const candidate of valid) {
      if (!/\.cmd$/i.test(candidate)) continue;
      try {
        const text = readFileSync(candidate, 'utf8');
        const match = text.match(/"([^"]*opencode\.exe)"/i);
        if (match?.[1]) {
          // Shims address their target relative to themselves (%~dp0).
          const target = normalize(match[1].replace(/^%~dp0/i, `${dirname(candidate)}\\`));
          if (existsSync(target)) return target;
        }
      } catch {
        // unreadable shim — fall through to the generic preference below
      }
    }
    const exe = valid.find((c) => c.toLowerCase().endsWith('.exe'));
    if (exe) return exe;
  }
  return valid[0] ?? null;
}

/** Sync existence probe for the dispatch hot path (no spawn). */
export function isOpencodeBinaryOnPath(pathEnv?: string): boolean {
  const rawPath = pathEnv ?? process.env.PATH ?? process.env.Path ?? '';
  const separator = process.platform === 'win32' ? ';' : ':';
  const exts = process.platform === 'win32'
    ? ['.exe', '.cmd', '.bat', '.ps1', '']
    : [''];
  for (const dir of rawPath.split(separator)) {
    if (!dir.trim()) continue;
    for (const ext of exts) {
      try {
        if (existsSync(join(dir, `opencode${ext}`))) return true;
      } catch {
        // unreadable dir — keep scanning
      }
    }
  }
  return false;
}

export function findOpencodeBinary(pathEnv?: string): Promise<string | null> {
  if (cachedBinary !== undefined) return Promise.resolve(cachedBinary);
  const separator = process.platform === 'win32' ? ';' : ':';
  const systemRoot = process.env.SystemRoot ?? (process.platform === 'win32' ? 'C:\\Windows' : '');
  const where =
    process.platform === 'win32' ? join(systemRoot, 'System32', 'where.exe') : 'which';
  // Prepend: the override wins the lookup while system tools stay resolvable.
  const searchPath =
    pathEnv !== undefined ? `${pathEnv}${separator}${process.env.PATH ?? process.env.Path ?? ''}` : undefined;
  return new Promise((resolve) => {
    execFile(
      where,
      ['opencode'],
      { env: { ...process.env, ...(searchPath !== undefined ? { PATH: searchPath, Path: searchPath } : {}) } },
      (error, stdout) => {
        if (error) {
          cachedBinary = null;
          resolve(null);
          return;
        }
        const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        cachedBinary = pickBinary(lines);
        resolve(cachedBinary);
      },
    );
  });
}

/**
 * Serializes observer spawns: at most one `opencode run` at a time, so two
 * concurrent observer generators never interleave prompts in the one reused
 * session (which would cross-contaminate both batches' context).
 */
let runChain: Promise<unknown> = Promise.resolve();
export function withObserverRunLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = runChain.catch(() => {}).then(fn);
  runChain = run;
  return run;
}

// ---------------------------------------------------------------------------
// Session inventory (fixed directory only) for reuse + cleanup.
// `opencode session list --format json` in the observer directory.
// ---------------------------------------------------------------------------

export interface ObserverSessionEntry {
  id: string;
  title?: string;
  /** Epoch ms when known (list order is newest-first regardless). */
  timeMs?: number;
}

function entryTimeMs(raw: Record<string, unknown>): number | undefined {
  for (const key of ['time', 'created', 'updated', 'createdAt', 'updatedAt', 'timestamp']) {
    const value = raw[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value > 1e12 ? value : value * 1000;
    }
    if (typeof value === 'string' && value.trim()) {
      const parsed = Date.parse(value);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return undefined;
}

export function parseSessionList(jsonText: string): ObserverSessionEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }
  const items = Array.isArray(parsed) ? parsed : (parsed as { sessions?: unknown }).sessions;
  if (!Array.isArray(items)) return [];
  const entries: ObserverSessionEntry[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const id = [raw.id, raw.sessionID, raw.sessionId].find((v) => typeof v === 'string' && v.trim());
    if (typeof id !== 'string') continue;
    const title = [raw.title, raw.name].find((v) => typeof v === 'string');
    entries.push({
      id,
      ...(typeof title === 'string' ? { title } : {}),
      ...(entryTimeMs(raw) !== undefined ? { timeMs: entryTimeMs(raw) } : {}),
    });
  }
  return entries;
}

async function runOpencodeLocal(args: string[], timeoutMs = 30_000): Promise<string | null> {
  const binary = await findOpencodeBinary();
  if (!binary) return null;
  return new Promise((resolve) => {
    execFile(binary, args, { cwd: observerDir(), timeout: timeoutMs }, (error, stdout) => {
      resolve(error ? null : stdout);
    });
  });
}

/** Newest-first sentinel sessions in the fixed directory (never the current). */
export async function listObserverSessions(currentId: string | null): Promise<ObserverSessionEntry[]> {
  const out = await runOpencodeLocal(['session', 'list', '--format', 'json']);
  if (out === null) return [];
  return parseSessionList(out).filter(
    (e) => e.id !== currentId && (e.title ?? '').includes(OBSERVER_SESSION_TITLE),
  );
}

/**
 * Pure cleanup plan: delete a sentinel session when it is older than
 * KEEP_RECENT_DAYS or past the KEEP_RECENT_COUNT newest (list is newest-first).
 * The archived current id is never a candidate — callers filter it out first.
 */
export function planObserverCleanup(
  newestFirst: ObserverSessionEntry[],
  nowMs: number = Date.now(),
): ObserverSessionEntry[] {
  const maxAgeMs = OBSERVER_KEEP_RECENT_DAYS * 24 * 60 * 60 * 1000;
  return newestFirst.filter(
    (entry, index) => index >= OBSERVER_KEEP_RECENT_COUNT || (entry.timeMs !== undefined && nowMs - entry.timeMs > maxAgeMs),
  );
}

/** Delete stale sentinel sessions; logs before/after. Never touches the current id. */
export async function cleanupObserverSessions(currentId: string | null): Promise<void> {
  const candidates = await listObserverSessions(currentId);
  const doomed = planObserverCleanup(candidates);
  if (doomed.length === 0) {
    logger.debug('SDK', 'Opencode observer cleanup: nothing to delete', {
      sentinelSessions: candidates.length,
    });
    return;
  }
  logger.info('SDK', 'Opencode observer cleanup: deleting stale sessions', {
    deleting: doomed.map((d) => d.id),
    keeping: candidates.length - doomed.length,
  });
  for (const entry of doomed) {
    await runOpencodeLocal(['session', 'delete', entry.id]);
  }
  const remaining = await listObserverSessions(currentId);
  logger.info('SDK', 'Opencode observer cleanup done', {
    deleted: doomed.length,
    remaining: remaining.length,
  });
}

/**
 * Pure check over a `session export` document: every text-bearing message
 * must open with the sentinel. Assistant turns carry no top-level text, so a
 * foreign user prompt is the only pollution signal. Unverifiable shapes fail
 * closed (false) — the caller decides whether to reuse anyway.
 */
export function exportMessagesClean(exportOutput: string): boolean {
  // The CLI occasionally wraps its JSON in notices (update hints, plugin
  // logs): carve the document out instead of demanding pristine output.
  const start = exportOutput.indexOf('{');
  const end = exportOutput.lastIndexOf('}');
  if (start === -1 || end <= start) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(exportOutput.slice(start, end + 1));
  } catch {
    return false;
  }
  const messages = (parsed as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return false;
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const text = (message as { text?: unknown }).text;
    if (typeof text !== 'string' || !text.trim()) continue;
    if (!isObserverPromptSentinel(text)) return false;
  }
  return true;
}

const verifiedCleanSessions = new Set<string>();

/**
 * Whether the archived session is still ours alone. Reads `session export`
 * (local, no gateway) and abandons the session on foreign user prompts, so a
 * polluted long-lived session is rotated instead of reused. Unverifiable
 * exports reuse anyway (logged): the worker skips still bound every event.
 */
export async function isArchivedSessionClean(sessionId: string): Promise<boolean> {
  if (verifiedCleanSessions.has(sessionId)) return true;
  const out = await runOpencodeLocal(['session', 'export', sessionId]);
  if (out === null) {
    logger.warn('SDK', 'Opencode observer session export failed; reusing anyway', { sessionId });
    return true;
  }
  if (!exportMessagesClean(out)) {
    logger.warn('SDK', 'Opencode observer session polluted by non-sentinel prompts; abandoning', {
      sessionId,
      exportPreview: out.slice(0, 160),
    });
    return false;
  }
  verifiedCleanSessions.add(sessionId);
  return true;
}
