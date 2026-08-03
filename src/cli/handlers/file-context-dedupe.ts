// #3480 — per-(session, file) dedupe for the file-context PreToolUse handler.
//
// Each hook invocation is a freshly spawned process (via bun-runner), so an
// in-memory Set cannot remember what was already surfaced this session. We keep
// a tiny persistent store — one JSON file per session under DATA_DIR — mapping a
// resolved file path to the newest observation epoch that was injected for it.
// A repeated Read of the same unchanged file is skipped unless a NEWER
// observation has been recorded since the last injection.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { resolveDataDir } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';

const DEDUPE_SUBDIR = 'file-context-seen';
// Sessions rarely outlive a few days; prune stale session files so the store
// never grows unbounded. Cheap because we only sweep on a session's first write.
const SESSION_FILE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type SeenMap = Record<string, number>;

function sessionFilePath(sessionId: string): string {
  // Session ids are UUID-ish, but sanitize defensively against path traversal /
  // separators so a hostile value can never escape the store directory.
  const safeId = sessionId.replace(/[^A-Za-z0-9_-]/g, '_');
  return join(resolveDataDir(), DEDUPE_SUBDIR, `${safeId}.json`);
}

function readSeen(filePath: string): SeenMap {
  try {
    if (!existsSync(filePath)) return {};
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
    return parsed && typeof parsed === 'object' ? (parsed as SeenMap) : {};
  } catch (err) {
    // A corrupt/unreadable store must never break a Read — treat as empty and
    // let it be overwritten on the next injection.
    logger.debug('HOOK', 'file-context dedupe store unreadable, treating as empty', {
      filePath,
      error: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
}

function pruneStaleSessions(storeDir: string): void {
  try {
    const now = Date.now();
    for (const name of readdirSync(storeDir)) {
      const full = join(storeDir, name);
      try {
        if (now - statSync(full).mtimeMs > SESSION_FILE_TTL_MS) unlinkSync(full);
      } catch {
        // Concurrent prune/removal — ignore this entry and continue.
      }
    }
  } catch (err) {
    logger.debug('HOOK', 'file-context dedupe prune failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * True when this (session, file) pair was already injected at an observation
 * epoch >= the current newest one — i.e. nothing new to say, skip re-injection.
 */
export function wasFileContextInjected(
  sessionId: string,
  resolvedPath: string,
  newestObservationEpoch: number,
): boolean {
  if (!sessionId) return false;
  const seen = readSeen(sessionFilePath(sessionId));
  const lastInjectedEpoch = seen[resolvedPath];
  return typeof lastInjectedEpoch === 'number' && lastInjectedEpoch >= newestObservationEpoch;
}

/** Record that this (session, file) pair was injected at `newestObservationEpoch`. */
export function recordFileContextInjection(
  sessionId: string,
  resolvedPath: string,
  newestObservationEpoch: number,
): void {
  if (!sessionId) return;
  const filePath = sessionFilePath(sessionId);
  const storeDir = join(resolveDataDir(), DEDUPE_SUBDIR);
  try {
    const firstWriteForSession = !existsSync(filePath);
    mkdirSync(storeDir, { recursive: true });
    if (firstWriteForSession) pruneStaleSessions(storeDir);
    const seen = readSeen(filePath);
    seen[resolvedPath] = newestObservationEpoch;
    writeFileSync(filePath, JSON.stringify(seen), 'utf-8');
  } catch (err) {
    // Persisting the marker is best-effort — a failure just means the next Read
    // may re-inject (fail-open), which is strictly safe.
    logger.debug('HOOK', 'file-context dedupe store write failed', {
      filePath,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
