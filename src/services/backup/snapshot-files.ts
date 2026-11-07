/**
 * Snapshot file naming plus the two small JSON files a restore goes
 * through. Plain fs only: the npx CLI (Node) stages restores with it, and
 * the worker (Bun) applies them.
 */
import { existsSync, readFileSync, unlinkSync } from 'fs';
import path from 'path';
import { paths } from '../../shared/paths.js';
import { parseJsonWithBom, writeJsonFileAtomic } from '../../shared/atomic-json.js';

/**
 * Snapshots are named claude-mem-<sanitized ISO ts>.db, so name order is time
 * order. The trailing `.db` anchor keeps staging leftovers and sidecars out.
 */
export const SNAPSHOT_FILE_PATTERN = /^claude-mem-.*\.db$/;

/**
 * Resolve a snapshot name to a path strictly inside `backupsDir`, or null for
 * anything that escapes it (`../../etc/passwd`, an absolute path) or does not
 * name a snapshot file.
 */
export function resolveSnapshotInside(backupsDir: string, name: string): string | null {
  const root = path.resolve(backupsDir);
  const resolved = path.resolve(root, name);
  if (path.dirname(resolved) !== root) return null;
  if (!SNAPSHOT_FILE_PATTERN.test(path.basename(resolved))) return null;
  return resolved;
}

export interface PendingRestore {
  /** Snapshot basename inside paths.backups(). */
  snapshot: string;
  requestedAt: number;
}

export interface LastRestoreResult {
  snapshot: string;
  at: number;
  ok: boolean;
  preRestoreCopy: string | null;
  error: string | null;
}

export function stagePendingRestore(snapshot: string, markerPath = paths.pendingRestore()): void {
  const pending: PendingRestore = { snapshot, requestedAt: Date.now() };
  writeJsonFileAtomic(markerPath, pending, { mode: 0o600 });
}

/** The staged restore, or null when none is staged. Throws on a corrupt marker. */
export function readPendingRestore(markerPath = paths.pendingRestore()): PendingRestore | null {
  if (!existsSync(markerPath)) return null;
  const parsed = parseJsonWithBom<Partial<PendingRestore>>(readFileSync(markerPath, 'utf-8'));
  if (typeof parsed?.snapshot !== 'string' || parsed.snapshot === '') {
    throw new Error(`restore marker has no snapshot name: ${markerPath}`);
  }
  return { snapshot: parsed.snapshot, requestedAt: Number(parsed.requestedAt) || 0 };
}

export function clearPendingRestore(markerPath = paths.pendingRestore()): void {
  if (existsSync(markerPath)) unlinkSync(markerPath);
}

export function writeLastRestoreResult(result: LastRestoreResult, resultPath = paths.lastRestore()): void {
  writeJsonFileAtomic(resultPath, result, { mode: 0o600 });
}

export function readLastRestoreResult(resultPath = paths.lastRestore()): LastRestoreResult | null {
  if (!existsSync(resultPath)) return null;
  return parseJsonWithBom<LastRestoreResult>(readFileSync(resultPath, 'utf-8'));
}
