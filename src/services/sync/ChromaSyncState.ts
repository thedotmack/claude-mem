import { existsSync } from 'fs';
import { join } from 'path';
import { readJsonFileWithBom, writeJsonFileAtomic } from '../../shared/atomic-json.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { logger } from '../../utils/logger.js';

export type DocKind = 'observations' | 'summaries' | 'prompts';

type PendingIdsByKind = Partial<Record<DocKind, number[]>>;

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

function normalizePendingIds(ids: unknown): number[] {
  if (!Array.isArray(ids)) {
    return [];
  }

  return [...new Set(
    ids.filter((id): id is number => Number.isInteger(id) && id > 0)
  )].sort((a, b) => a - b);
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
    cache = {};
    return cache;
  }
  let parsed: Record<string, Partial<ProjectWatermarks>>;
  try {
    parsed = readJsonFileWithBom<Record<string, Partial<ProjectWatermarks>>>(path);
  } catch (error) {
    // A truncated or corrupt state file must not abort the sync pipeline. Treat
    // it as empty and rebuild from the SQLite watermarks on the next backfill.
    logger.warn('CHROMA_SYNC', 'Unreadable chroma-sync-state.json, treating as empty', {
      path
    }, error instanceof Error ? error : new Error(String(error)));
    cache = {};
    return cache;
  }
  const normalized: Record<string, ProjectWatermarks> = {};
  for (const [project, marks] of Object.entries(parsed)) {
    normalized[project] = normalizeProjectWatermarks(marks);
  }
  cache = normalized;
  return cache;
}

function persist(): void {
  if (!cache) return;
  writeJsonFileAtomic(statePath(), cache);
}

export const ChromaSyncState = {
  /** Test hook: drop the in-memory watermark cache so the next read hits disk. */
  resetCacheForTests(): void {
    cache = null;
  },

  exists(): boolean {
    return existsSync(statePath());
  },

  get(project: string): ProjectWatermarks {
    const all = load();
    return normalizeProjectWatermarks(all[project] ?? ZERO);
  },

  getPending(project: string, kind: DocKind): number[] {
    return this.get(project).pending?.[kind] ?? [];
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

  /** Flag every project with recorded progress for a rebuild from zero (#3202). */
  markAllForRebuild(): void {
    const all = load();
    for (const project of Object.keys(all)) {
      all[project] = { ...normalizeProjectWatermarks(all[project]), rebuildPending: true };
    }
    persist();
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

  markFragmentReconciliation(project: string, kind: DocKind, id: number): void {
    const all = load();
    const current = normalizeProjectWatermarks(all[project] ?? ZERO);
    current.pending = current.pending ?? {};
    current.pending[kind] = normalizePendingIds([...(current.pending[kind] ?? []), id]);
    current.fragmentReconciliation = current.fragmentReconciliation ?? {};
    current.fragmentReconciliation[kind] = normalizePendingIds([...(current.fragmentReconciliation[kind] ?? []), id]);
    all[project] = current;
    persist();
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
