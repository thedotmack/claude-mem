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
const STATE_VERSION = 2;

interface PersistedGbrainSyncState {
  version: typeof STATE_VERSION;
  projects: Record<string, Partial<GbrainProjectWatermarks>>;
}

function statePath(): string {
  const dataDir = SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR');
  return join(dataDir, 'gbrain-sync-state.json');
}

let cache: Record<string, GbrainProjectWatermarks> | null = null;
let cachePath: string | null = null;

function normalizeProjectWatermarks(marks: Partial<GbrainProjectWatermarks> | undefined): GbrainProjectWatermarks {
  return {
    observations: Number.isInteger(marks?.observations) && (marks?.observations as number) > 0
      ? marks?.observations as number
      : 0,
  };
}

function load(): Record<string, GbrainProjectWatermarks> {
  const path = statePath();
  if (cache && cachePath === path) return cache;
  cachePath = path;
  if (!existsSync(path)) {
    cache = {};
    return cache;
  }

  let parsed: PersistedGbrainSyncState;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as PersistedGbrainSyncState;
  } catch (error) {
    // A corrupt watermark must fail open toward re-importing. Treating it as a
    // high watermark could permanently skip observations; gbrain imports are
    // idempotent, so a full replay is the safe recovery.
    logger.warn('GBRAIN_SYNC', 'Ignoring unreadable gbrain sync state; a full backfill will repair it', { path }, error as Error);
    cache = {};
    return cache;
  }

  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    parsed.version !== STATE_VERSION ||
    parsed.projects === null ||
    typeof parsed.projects !== 'object' ||
    Array.isArray(parsed.projects)
  ) {
    // Version 1 advanced this scalar from live captures. A later successful
    // capture could jump past earlier failures or writes from another lane
    // (notably EAT), creating permanent holes. Discard that unsafe legacy
    // watermark once; the v2 backfill replays idempotently from zero.
    logger.warn('GBRAIN_SYNC', 'Resetting legacy gbrain sync watermarks for a one-time full backfill', { path });
    cache = {};
    return cache;
  }

  const normalized: Record<string, GbrainProjectWatermarks> = {};
  for (const [project, marks] of Object.entries(parsed.projects)) {
    normalized[project] = normalizeProjectWatermarks(marks);
  }
  cache = normalized;
  return cache;
}

function persist(): void {
  if (!cache) return;
  const path = cachePath ?? statePath();
  const dataDir = SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR');
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const tmp = `${path}.tmp`;
  const persisted: PersistedGbrainSyncState = {
    version: STATE_VERSION,
    projects: cache,
  };
  writeFileSync(tmp, JSON.stringify(persisted, null, 2), 'utf8');
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
