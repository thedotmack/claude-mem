import { existsSync } from 'fs';
import { join } from 'path';
import { readJsonFileWithBom, writeJsonFileAtomic } from '../../shared/atomic-json.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { logger } from '../../utils/logger.js';

export type DocKind = 'observations' | 'summaries' | 'prompts';

type PendingIdsByKind = Partial<Record<DocKind, number[]>>;

/**
 * One post-delete Chroma cleanup that failed and must be retried (#5664). The
 * SQLite row is already committed gone, so the Chroma doc_type and sqlite_id
 * are all a retry needs: the row's DELETE route answers 404 from now on, and
 * backfill only walks rows that still exist, so nothing else can reach the
 * documents these name.
 */
export interface PendingRowDelete {
  /** Chroma doc_type, e.g. 'observation' — what deleteRowDocuments takes. */
  docType: string;
  sqliteId: number;
}

/**
 * Key of the retry list inside chroma-sync-state.json, whose other entries are
 * project watermarks. The list is an array and a project entry is an object, so
 * a project that happens to carry this name still loads as a project.
 */
const PENDING_DELETES_KEY = '__pending_row_deletes__';

export interface ProjectWatermarks {
  observations: number;
  summaries: number;
  prompts: number;
  pending?: PendingIdsByKind;
  /** Rows whose remote revision must remove obsolete document fragments. */
  fragmentReconciliation?: PendingIdsByKind;
  /**
   * Set once this project's title-only observations, which older versions
   * skipped while advancing the watermark, have been requeued (#4069).
   */
  titleOnlyRequeued?: boolean;
  /**
   * Set when this project's documents went with a dropped corrupt collection
   * (#3202). Its next backfill starts from zero and clears the flag only when
   * it completes, so a restart mid-rebuild simply rebuilds again.
   */
  rebuildPending?: boolean;
}

const ZERO: ProjectWatermarks = { observations: 0, summaries: 0, prompts: 0 };

function statePath(): string {
  const dataDir = SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR');
  return join(dataDir, 'chroma-sync-state.json');
}

let cache: Record<string, ProjectWatermarks> | null = null;
/**
 * Failed post-delete cleanups, in the same file as the watermarks so they
 * survive the worker that gave up on them. Null until the file is read.
 */
let pendingDeletesCache: PendingRowDelete[] | null = null;

function createProjectMap(): Record<string, ProjectWatermarks> {
  // Project names come from directory names, so every string (including
  // __proto__) must be an own, serializable entry in the checkpoint map.
  return Object.create(null);
}

/**
 * After a failed write, skip writes for this long. The backfill writes once or
 * twice per row, and each failed write can block for the full rename retry.
 */
const PERSIST_FAILURE_BACKOFF_MS = 5_000;
let persistBlockedUntil = 0;

function normalizePendingIds(ids: unknown): number[] {
  if (!Array.isArray(ids)) {
    return [];
  }

  return [...new Set(
    ids.filter((id): id is number => Number.isInteger(id) && id > 0)
  )].sort((a, b) => a - b);
}

/** Drop malformed and duplicate entries; keep the first occurrence's order. */
function normalizePendingRowDeletes(value: unknown): PendingRowDelete[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const rows: PendingRowDelete[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const docType = (entry as { docType?: unknown }).docType;
    const sqliteId = (entry as { sqliteId?: unknown }).sqliteId;
    if (typeof docType !== 'string' || docType.length === 0) continue;
    if (typeof sqliteId !== 'number' || !Number.isInteger(sqliteId) || sqliteId <= 0) continue;
    const key = pendingDeleteKey({ docType, sqliteId });
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ docType, sqliteId });
  }
  return rows;
}

function pendingDeleteKey(row: PendingRowDelete): string {
  return `${row.docType}:${row.sqliteId}`;
}

function normalizeProjectWatermarks(marks: Partial<ProjectWatermarks> | undefined): ProjectWatermarks {
  const pending = typeof marks?.pending === 'object' && marks?.pending !== null
    ? {
        observations: normalizePendingIds(marks?.pending?.observations),
        summaries: normalizePendingIds(marks?.pending?.summaries),
        prompts: normalizePendingIds(marks?.pending?.prompts),
      }
    : undefined;

  const normalized: ProjectWatermarks = {
    observations: Number.isInteger(marks?.observations) ? marks?.observations as number : 0,
    summaries: Number.isInteger(marks?.summaries) ? marks?.summaries as number : 0,
    prompts: Number.isInteger(marks?.prompts) ? marks?.prompts as number : 0,
  };

  if (pending && (pending.observations.length > 0 || pending.summaries.length > 0 || pending.prompts.length > 0)) {
    normalized.pending = pending;
  }

  if (marks?.fragmentReconciliation) {
    normalized.fragmentReconciliation = {
      observations: normalizePendingIds(marks.fragmentReconciliation.observations),
      summaries: normalizePendingIds(marks.fragmentReconciliation.summaries),
    };
  }

  if (marks?.titleOnlyRequeued === true) {
    normalized.titleOnlyRequeued = true;
  }

  if (marks?.rebuildPending === true) {
    normalized.rebuildPending = true;
  }

  return normalized;
}

function load(): Record<string, ProjectWatermarks> {
  if (cache) return cache;
  const path = statePath();
  if (!existsSync(path)) {
    cache = createProjectMap();
    pendingDeletesCache = [];
    return cache;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = readJsonFileWithBom<Record<string, unknown>>(path);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('checkpoint must be a project-watermark object');
    }
  } catch (error) {
    // A truncated or corrupt state file must not abort the sync pipeline. Treat
    // it as empty and rebuild from the SQLite watermarks on the next backfill.
    logger.warn('CHROMA_SYNC', 'Unreadable chroma-sync-state.json, treating as empty', {
      path
    }, error instanceof Error ? error : new Error(String(error)));
    cache = createProjectMap();
    pendingDeletesCache = [];
    return cache;
  }
  const normalized = createProjectMap();
  pendingDeletesCache = [];
  for (const [project, marks] of Object.entries(parsed)) {
    // The retry list is the file's one array-valued entry; a project entry is
    // always an object, so a project named like the reserved key still loads.
    if (project === PENDING_DELETES_KEY && Array.isArray(marks)) {
      pendingDeletesCache = normalizePendingRowDeletes(marks);
      continue;
    }
    normalized[project] = normalizeProjectWatermarks(marks as Partial<ProjectWatermarks>);
  }
  cache = normalized;
  return cache;
}

function persistOrThrow(): void {
  if (!cache) return;
  // The common path (a watermark or pending-row change) writes the project map
  // exactly as before; only retry records need the extra entry.
  if (!pendingDeletesCache || pendingDeletesCache.length === 0) {
    writeJsonFileAtomic(statePath(), cache);
    return;
  }
  const body: Record<string, unknown> = createProjectMap();
  for (const [project, marks] of Object.entries(cache)) {
    body[project] = marks;
  }
  if (Object.hasOwn(body, PENDING_DELETES_KEY)) {
    // A project own-names the reserved key. Keeping its watermarks matters
    // more than the retry list, which is only ever a fallback.
    logger.warn('CHROMA_SYNC', 'A project shadows the pending-delete key; its watermarks are kept and the retry list is not persisted', {
      project: PENDING_DELETES_KEY
    });
  } else {
    body[PENDING_DELETES_KEY] = pendingDeletesCache;
  }
  writeJsonFileAtomic(statePath(), body);
}

/**
 * A failed write must not abort the sync pipeline. The cache keeps the
 * change, the next persist writes it, and SQLite stays the source of truth.
 */
function persist(): void {
  if (Date.now() < persistBlockedUntil) return;
  try {
    persistOrThrow();
  } catch (error) {
    persistBlockedUntil = Date.now() + PERSIST_FAILURE_BACKOFF_MS;
    logger.warn('CHROMA_SYNC', 'Could not write chroma-sync-state.json, will retry on the next change', {
      path: statePath()
    }, error instanceof Error ? error : new Error(String(error)));
  }
}

export const ChromaSyncState = {
  /** Test hook: drop the in-memory watermark cache so the next read hits disk. */
  resetCacheForTests(): void {
    cache = null;
    pendingDeletesCache = null;
    persistBlockedUntil = 0;
  },

  exists(): boolean {
    return existsSync(statePath());
  },

  /**
   * True when the file records at least one project watermark. A file holding
   * only pending row deletes says nothing about which rows are already
   * indexed, so it still needs the one-time bootstrap.
   */
  hasProjectState(): boolean {
    if (!this.exists()) return false;
    return Object.keys(load()).length > 0;
  },

  get(project: string): ProjectWatermarks {
    const all = load();
    return normalizeProjectWatermarks(all[project] ?? ZERO);
  },

  getPending(project: string, kind: DocKind): number[] {
    return this.get(project).pending?.[kind] ?? [];
  },

  /**
   * Post-delete cleanups Chroma refused, oldest first. They are retried by the
   * next backfill sweep, the same pass that drains pending writes.
   */
  getPendingRowDeletes(): PendingRowDelete[] {
    load();
    return (pendingDeletesCache ?? []).map(row => ({ ...row }));
  },

  /** Record failed cleanups. One write per batch, not per row. */
  markPendingRowDeletes(rows: ReadonlyArray<PendingRowDelete>): void {
    const added = normalizePendingRowDeletes(rows);
    if (added.length === 0) return;

    load();
    const existing = pendingDeletesCache ?? [];
    const seen = new Set(existing.map(pendingDeleteKey));
    const merged = [...existing];
    for (const row of added) {
      const key = pendingDeleteKey(row);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(row);
    }
    if (merged.length === existing.length) return;

    pendingDeletesCache = merged;
    // The record must reach the disk before the caller proceeds: the process
    // that just failed the cleanup is the one that may exit next, and `persist`
    // silently defers behind its failure backoff. Keep the cleanup lane
    // non-throwing, but report a write that could not happen.
    try {
      persistOrThrow();
    } catch (error) {
      logger.warn('CHROMA_SYNC', 'Could not record a pending post-delete cleanup', {},
        error instanceof Error ? error : new Error(String(error)));
    }
  },

  /** Forget cleanups that succeeded (or whose row came back) in one write. */
  clearPendingRowDeletes(rows: ReadonlyArray<PendingRowDelete>): void {
    const done = normalizePendingRowDeletes(rows);
    if (done.length === 0) return;

    load();
    const existing = pendingDeletesCache ?? [];
    if (existing.length === 0) return;
    const finished = new Set(done.map(pendingDeleteKey));
    const remaining = existing.filter(row => !finished.has(pendingDeleteKey(row)));
    if (remaining.length === existing.length) return;

    pendingDeletesCache = remaining;
    persist();
  },

  isTitleOnlyRequeued(project: string): boolean {
    return this.get(project).titleOnlyRequeued === true;
  },

  markTitleOnlyRequeued(project: string): void {
    const all = load();
    const current = normalizeProjectWatermarks(all[project] ?? ZERO);
    if (current.titleOnlyRequeued) return;
    current.titleOnlyRequeued = true;
    all[project] = current;
    persist();
  },

  /**
   * Flag every project with recorded progress for a rebuild from zero (#3202).
   * Throws when the write fails: the collection is dropped only after the
   * flags are on disk.
   */
  markAllForRebuild(): void {
    const all = load();
    for (const project of Object.keys(all)) {
      all[project] = { ...normalizeProjectWatermarks(all[project]), rebuildPending: true };
    }
    persistOrThrow();
  },

  isRebuildPending(project: string): boolean {
    return this.get(project).rebuildPending === true;
  },

  /**
   * Zero a flagged project's progress at the start of its rebuild. This drops
   * whatever live writes bumped since the collection was dropped, so they
   * cannot hide older rows; the flag stays until finishRebuild.
   */
  resetForRebuild(project: string): void {
    const all = load();
    all[project] = { ...ZERO, rebuildPending: true };
    persist();
  },

  finishRebuild(project: string): void {
    const all = load();
    const current = normalizeProjectWatermarks(all[project] ?? ZERO);
    if (!current.rebuildPending) return;
    delete current.rebuildPending;
    all[project] = current;
    persist();
  },

  bump(project: string, kind: DocKind, id: number): void {
    if (!Number.isInteger(id) || id <= 0) return;
    const all = load();
    const current = normalizeProjectWatermarks(all[project] ?? ZERO);
    let changed = false;

    if (id > current[kind]) {
      current[kind] = id;
      changed = true;
    }

    const pending = current.pending?.[kind] ?? [];
    if (pending.includes(id)) {
      const filtered = pending.filter(pendingId => pendingId !== id);
      current.pending = current.pending ?? {};
      if (filtered.length === 0) {
        delete current.pending[kind];
      } else {
        current.pending[kind] = filtered;
      }
      if (current.pending && Object.keys(current.pending).length === 0) {
        delete current.pending;
      }
      changed = true;
    }

    if (!changed) return;
    all[project] = current;
    persist();
  },

  replace(project: string, marks: ProjectWatermarks): void {
    const all = load();
    all[project] = normalizeProjectWatermarks(marks);
    persist();
  },

  markPending(project: string, kind: DocKind, ids: number[]): void {
    const normalizedIds = normalizePendingIds(ids);
    if (normalizedIds.length === 0) return;

    const all = load();
    const current = normalizeProjectWatermarks(all[project] ?? ZERO);
    const existing = current.pending?.[kind] ?? [];
    const merged = [...new Set([...existing, ...normalizedIds])].sort((a, b) => a - b);
    if (merged.length === existing.length && merged.every((id, index) => id === existing[index])) {
      return;
    }

    current.pending = current.pending ?? {};
    current.pending[kind] = merged;
    all[project] = current;
    persist();
  },

  /**
   * Throws when the write fails: the caller changes a row's existing documents
   * only after its pending entry and repair flag are on disk, so a restart
   * mid-repair retries the row even below the watermark.
   */
  markFragmentReconciliation(project: string, kind: DocKind, id: number): void {
    const all = load();
    const current = normalizeProjectWatermarks(all[project] ?? ZERO);
    current.pending = current.pending ?? {};
    current.pending[kind] = normalizePendingIds([...(current.pending[kind] ?? []), id]);
    current.fragmentReconciliation = current.fragmentReconciliation ?? {};
    current.fragmentReconciliation[kind] = normalizePendingIds([...(current.fragmentReconciliation[kind] ?? []), id]);
    all[project] = current;
    persistOrThrow();
  },

  needsFragmentReconciliation(project: string, kind: DocKind, id: number): boolean {
    return this.get(project).fragmentReconciliation?.[kind]?.includes(id) ?? false;
  },

  clearFragmentReconciliation(project: string, kind: DocKind, id: number): void {
    const all = load();
    const current = normalizeProjectWatermarks(all[project] ?? ZERO);
    if (!current.fragmentReconciliation?.[kind]?.includes(id)) return;
    current.fragmentReconciliation[kind] = current.fragmentReconciliation[kind]!.filter(value => value !== id);
    all[project] = current;
    persist();
  },

  clearPending(project: string, kind: DocKind, ids: number[]): void {
    const normalizedIds = normalizePendingIds(ids);
    if (normalizedIds.length === 0) return;

    const all = load();
    const current = normalizeProjectWatermarks(all[project] ?? ZERO);
    const existing = current.pending?.[kind] ?? [];
    if (existing.length === 0) return;

    const toRemove = new Set(normalizedIds);
    const filtered = existing.filter(id => !toRemove.has(id));
    if (filtered.length === existing.length) return;

    current.pending = current.pending ?? {};
    if (filtered.length === 0) {
      delete current.pending[kind];
    } else {
      current.pending[kind] = filtered;
    }
    if (current.pending && Object.keys(current.pending).length === 0) {
      delete current.pending;
    }
    all[project] = current;
    persist();
  }
};
