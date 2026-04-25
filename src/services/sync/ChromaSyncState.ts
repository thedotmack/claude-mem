/**
 * ChromaSyncState — per-project watermark cache for Chroma backfill.
 *
 * Replaces full Chroma metadata scans on every worker start with a tiny JSON file
 * tracking the highest sqlite_id synced to Chroma for each (project, doc_type).
 *
 * File: $CLAUDE_MEM_DATA_DIR/chroma-sync-state.json
 * Schema: { [project]: { observations: number, summaries: number, prompts: number } }
 *
 * Reads/writes are synchronous — the file is small and only touched at startup
 * and after batched adds. An in-memory cache mirrors the file; writes are
 * atomic via .tmp + rename.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { logger } from '../../utils/logger.js';

export type DocKind = 'observations' | 'summaries' | 'prompts';

export interface ProjectWatermarks {
  observations: number;
  summaries: number;
  prompts: number;
}

const ZERO: ProjectWatermarks = { observations: 0, summaries: 0, prompts: 0 };

function statePath(): string {
  const dataDir = SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR');
  return join(dataDir, 'chroma-sync-state.json');
}

let cache: Record<string, ProjectWatermarks> | null = null;
let dirty = false;

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
    normalized[project] = {
      observations: Number.isInteger(marks.observations) ? marks.observations as number : 0,
      summaries: Number.isInteger(marks.summaries) ? marks.summaries as number : 0,
      prompts: Number.isInteger(marks.prompts) ? marks.prompts as number : 0
    };
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
  dirty = false;
}

export const ChromaSyncState = {
  /** Whether the state file exists on disk. Used by callers to detect cold-start. */
  exists(): boolean {
    return existsSync(statePath());
  },

  /** Read current watermarks for a project. Returns zeros if unknown. */
  get(project: string): ProjectWatermarks {
    const all = load();
    return { ...(all[project] ?? ZERO) };
  },

  /** Bump a single watermark to max(current, id). No-op if id is not greater. */
  bump(project: string, kind: DocKind, id: number): void {
    if (!Number.isInteger(id) || id <= 0) return;
    const all = load();
    const current = all[project] ?? { ...ZERO };
    if (id <= current[kind]) return;
    current[kind] = id;
    all[project] = current;
    dirty = true;
    persist();
  },

  /**
   * Replace watermarks for a project wholesale. Used by the bootstrap path
   * after a one-time Chroma scan derives the initial highest IDs.
   */
  replace(project: string, marks: ProjectWatermarks): void {
    const all = load();
    all[project] = { ...marks };
    dirty = true;
    persist();
  },

  /** Persist any pending writes. Defensive — bump/replace flush already. */
  flush(): void {
    if (dirty) persist();
  },

  /** Test/diagnostic helper: drop in-memory cache so the next read re-reads disk. */
  resetCache(): void {
    cache = null;
    dirty = false;
  }
};
