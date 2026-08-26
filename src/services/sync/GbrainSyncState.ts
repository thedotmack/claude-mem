/**
 * Per-project gbrain sync watermarks — copied from ChromaSyncState, reduced to
 * the observations lane only (v1 syncs observations exclusively; YAGNI on
 * summaries/prompts). Atomic tmp+rename JSON persisted at
 * `<DATA_DIR>/gbrain-sync-state.json`.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { logger } from '../../utils/logger.js';

export interface GbrainProjectWatermarks {
  observations: number;
}

const ZERO: GbrainProjectWatermarks = { observations: 0 };

function statePath(): string {
  const dataDir = SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR');
  return join(dataDir, 'gbrain-sync-state.json');
}

let cache: Record<string, GbrainProjectWatermarks> | null = null;

function normalizeProjectWatermarks(marks: Partial<GbrainProjectWatermarks> | undefined): GbrainProjectWatermarks {
  return {
    observations: Number.isInteger(marks?.observations) ? marks?.observations as number : 0,
  };
}

function load(): Record<string, GbrainProjectWatermarks> {
  if (cache) return cache;
  const path = statePath();
  if (!existsSync(path)) {
    cache = {};
    return cache;
  }
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw) as Record<string, Partial<GbrainProjectWatermarks>>;
  const normalized: Record<string, GbrainProjectWatermarks> = {};
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

export const GbrainSyncState = {
  exists(): boolean {
    return existsSync(statePath());
  },

  get(project: string): GbrainProjectWatermarks {
    const all = load();
    return normalizeProjectWatermarks(all[project] ?? ZERO);
  },

  /** Advance the observations watermark — only forward, never regress. */
  bump(project: string, observationId: number): void {
    if (!Number.isInteger(observationId) || observationId <= 0) return;
    const all = load();
    const current = normalizeProjectWatermarks(all[project] ?? ZERO);
    if (observationId <= current.observations) return;
    current.observations = observationId;
    all[project] = current;
    persist();
  },

  replace(project: string, marks: GbrainProjectWatermarks): void {
    const all = load();
    all[project] = normalizeProjectWatermarks(marks);
    persist();
  }
};
