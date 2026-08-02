import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { logger } from '../../utils/logger.js';

export type DocKind = 'observations' | 'summaries' | 'prompts';

type PendingIdsByKind = Partial<Record<DocKind, number[]>>;

export interface ProjectWatermarks {
  observations: number;
  summaries: number;
  prompts: number;
  pending?: PendingIdsByKind;
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

  return normalized;
}

function load(): Record<string, ProjectWatermarks> {
  if (cache) return cache;
  const path = statePath();
  if (!existsSync(path)) {
    cache = {};
    return cache;
  }
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw) as Record<string, Partial<ProjectWatermarks>>;
  const normalized: Record<string, ProjectWatermarks> = {};
  for (const [project, marks] of Object.entries(parsed)) {
    normalized[project] = normalizeProjectWatermarks(marks);
  }
  cache = normalized;
  return cache;
}

function persist(): void {
  if (!cache) return;
  const path = statePath();
  const dataDir = SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR');
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
  renameSync(tmp, path);
}

export const ChromaSyncState = {
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
