import { closeSync, mkdirSync, openSync, statSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { readJsonFileWithBom, writeJsonFileAtomic } from '../../shared/atomic-json.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { logger } from '../../utils/logger.js';

/**
 * Containment-only recovery journal. This is not an interprocess lock:
 * deployments sharing a data directory must still enforce a single writer.
 * A confirmed delete is rebuilt using ChromaSyncState's durable rebuildPending
 * flags; the journal records ambiguous destructive operations, not index parity.
 */
export type RecoveryHealth =
  | { state: 'DROP_PENDING'; since: number }
  | { state: 'QUARANTINED'; since: number; reason: string };
export type RecoveryStatus = 'READY' | 'DROP_PENDING' | 'QUARANTINED' | 'UNKNOWN';

interface Journal {
  version: 1;
  collections: Record<string, RecoveryHealth>;
}
interface Cache {
  path: string;
  entries: Record<string, RecoveryHealth>;
  unreadable: boolean;
  diskSignature: string;
}
let cache: Cache | null = null;

function journalPath(): string {
  return join(SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR'), 'chroma-quarantine.json');
}
function emptyEntries(): Record<string, RecoveryHealth> {
  return Object.create(null) as Record<string, RecoveryHealth>;
}
function pathStat(path: string): { exists: boolean; stamp: string } {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) throw new Error('Recovery journal component is not a regular file');
    return { exists: true, stamp: `${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}` };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false, stamp: '-' };
    throw error;
  }
}
function signature(path: string): string {
  // Fail rather than assuming READY when a file is inaccessible.
  const journal = pathStat(path);
  const marker = pathStat(path + '.initialized');
  const lock = pathStat(path + '.lock');
  return `${journal.stamp}|${marker.stamp}|${lock.stamp}`;
}
function validate(value: unknown): Record<string, RecoveryHealth> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Recovery journal must be an object');
  const journal = value as Partial<Journal>;
  if (journal.version !== 1 || !journal.collections || typeof journal.collections !== 'object'
    || Array.isArray(journal.collections)) throw new Error('Unsupported recovery journal format');
  const entries = emptyEntries();
  for (const [collection, raw] of Object.entries(journal.collections)) {
    if (!collection || !raw || typeof raw !== 'object') throw new Error('Invalid recovery entry');
    const entry = raw as RecoveryHealth;
    if ((entry.state !== 'QUARANTINED' && entry.state !== 'DROP_PENDING')
      || !Number.isFinite(entry.since) || entry.since < 0
      || (entry.state === 'QUARANTINED' && typeof entry.reason !== 'string')) {
      throw new Error('Invalid recovery state for collection');
    }
    entries[collection] = entry;
  }
  return entries;
}
function loadFromDisk(path: string, lockHeldByUs = false): Record<string, RecoveryHealth> {
  if (!lockHeldByUs && pathStat(path + '.lock').exists) {
    throw new Error('Recovery journal transition lock is held or abandoned');
  }
  const marker = pathStat(path + '.initialized');
  if (marker.exists) {
    const parsed = readJsonFileWithBom<unknown>(path + '.initialized');
    if (!parsed || typeof parsed !== 'object' || (parsed as { version?: number }).version !== 1) {
      throw new Error('Invalid recovery journal initialization marker');
    }
  }
  if (!pathStat(path).exists) {
    // On a fresh legacy install both files are absent. Once the first delete
    // is attempted, the marker is persisted BEFORE the journal, so deleting or
    // losing the journal can no longer silently restore READY.
    if (marker.exists) throw new Error('Recovery journal missing after initialization');
    return emptyEntries();
  }
  const entries = validate(readJsonFileWithBom<unknown>(path));
  if (!lockHeldByUs && pathStat(path + '.lock').exists) {
    throw new Error('Recovery journal transition started while state was being read');
  }
  return entries;
}
function getCache(): Cache {
  const path = journalPath();
  let currentSignature = '';
  try {
    currentSignature = signature(path);
    if (cache?.path === path && cache.diskSignature === currentSignature) return cache;
  } catch (error) {
    logger.error('CHROMA_SYNC', 'Recovery journal metadata cannot be read; refusing Chroma operations',
      { path }, error instanceof Error ? error : new Error(String(error)));
    cache = { path, entries: cache?.path === path ? cache.entries : emptyEntries(), unreadable: true, diskSignature: '' };
    return cache;
  }

  const next: Cache = { path, entries: emptyEntries(), unreadable: false, diskSignature: currentSignature };
  try {
    next.entries = loadFromDisk(path);
  } catch (error) {
    next.unreadable = true;
    logger.error('CHROMA_SYNC', 'Recovery journal unreadable or transition lock held; refusing Chroma operations',
      { path }, error instanceof Error ? error : new Error(String(error)));
  }
  cache = next;
  return next;
}

/**
 * Interprocess atomic creation serializes journal *transitions*. This is NOT
 * a lease to perform vector writes: the Chroma writer lock controls that
 * separately. An abandoned lock after a crash remains fail-closed until an
 * operator verifies the collection and repairs the journal.
 */
function withJournalLock(path: string, action: () => void): void {
  mkdirSync(dirname(path), { recursive: true });
  const lockPath = path + '.lock';
  const handle = openSync(lockPath, 'wx', 0o600);
  try {
    action();
  } finally {
    closeSync(handle);
    unlinkSync(lockPath);
  }
}
function writeJournal(path: string, entries: Record<string, RecoveryHealth>): void {
  // Marker first: crash between marker and journal creation is blocked at
  // startup, even when the journal was never successfully published.
  const markerPath = path + '.initialized';
  if (!pathStat(markerPath).exists) {
    writeJsonFileAtomic(markerPath, { version: 1 }, { mode: 0o600 });
  }
  writeJsonFileAtomic(path, { version: 1, collections: entries }, { mode: 0o600 });
}
function transition(collection: string, value: RecoveryHealth | null): void {
  const current = getCache();
  if (current.unreadable) throw new Error('Recovery journal unreadable; inspect before modifying');
  const before = current.entries[collection]?.state ?? 'READY';
  if (value) current.entries[collection] = value; // block this process before attempting persistence
  try {
    withJournalLock(current.path, () => {
      // Re-read under the exclusive transition lock to prevent competing
      // processes overwriting one another's collection entries.
      const onDisk = loadFromDisk(current.path, true);
      const actual: RecoveryStatus = Object.hasOwn(onDisk, collection)
        ? onDisk[collection].state : 'READY';
      if ((value?.state === 'DROP_PENDING' && actual !== 'READY')
        || (value?.state === 'QUARANTINED' && actual !== 'DROP_PENDING')
        || (value === null && actual !== 'DROP_PENDING')) {
        throw new Error(`Conflicting recovery transition ${actual} -> ${value?.state ?? 'READY'}`);
      }
      if (value) onDisk[collection] = value;
      else delete onDisk[collection];
      writeJournal(current.path, onDisk);
      current.entries = onDisk;
    });
  } catch (error) {
    // Never assume the on-disk state is safe after a failed journal
    // transaction; even a successful delete may now be unconfirmed to us.
    current.unreadable = true;
    logger.error('CHROMA_SYNC', 'Recovery transition failed; vector operations blocked',
      { collection, state: value?.state ?? 'READY' }, error instanceof Error ? error : new Error(String(error)));
    throw error;
  } finally {
    // A subsequent reader (including another worker) reloads the published
    // journal state rather than carrying a stale snapshot indefinitely.
    try { current.diskSignature = signature(current.path); } catch { current.diskSignature = ''; }
  }
  logger.warn('CHROMA_SYNC', 'Collection recovery state transition', {
    collection, from: before, to: value?.state ?? 'READY',
  });
}

export const ChromaRecoveryHealth = {
  get(collection: string): RecoveryStatus {
    const current = getCache();
    if (current.unreadable) return 'UNKNOWN';
    return current.entries[collection]?.state ?? 'READY';
  },

  isAvailable(collection: string): boolean {
    return this.get(collection) === 'READY';
  },

  beginDrop(collection: string): void {
    const state = this.get(collection);
    if (state === 'UNKNOWN') throw new Error('Recovery journal unreadable; collection mutations disabled');
    if (state !== 'READY') throw new Error('Collection is already in recovery or quarantine');
    transition(collection, { state: 'DROP_PENDING', since: Date.now() });
  },

  quarantine(collection: string, cause: unknown): void {
    const message = cause instanceof Error ? cause.message : String(cause);
    transition(collection, { state: 'QUARANTINED', since: Date.now(), reason: message.slice(0, 256) });
  },

  completeConfirmedDrop(collection: string): void {
    if (this.get(collection) !== 'DROP_PENDING') {
      throw new Error('Cannot clear a collection without a confirmed pending delete');
    }
    transition(collection, null);
  },

  /** Test seam: models a fresh worker loading its journal after a process exit. */
  resetCacheForTests(): void { cache = null; },
};
