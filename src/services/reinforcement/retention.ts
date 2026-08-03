// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'crypto';
import type { Database } from 'bun:sqlite';
import { logger } from '../../utils/logger.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { effectiveStrength, parseReinforcementDates, readTunables } from './strength.js';

/**
 * Retention policy — explicit, opt-in deletion of stale observations
 * (memory-review audit G2, plans/2026-07-31-memory-review-audit.md).
 *
 * The review rule is "score, don't erase" for RANKING (C3) — ACT-R strength
 * never deletes anything by itself. Deletion is a separate explicit POLICY
 * (C10: periodical frequency/age-threshold deletion yields large size
 * reduction at <2% accuracy cost). This module is that policy:
 *
 *   candidate ⇔ created_at_epoch older than MIN_AGE_DAYS
 *             AND effectiveStrength(reinforcement_dates) < MIN_STRENGTH
 *             AND COALESCE(relevance_count, 0) = 0   (never surfaced)
 *             AND superseded_by IS NULL              (not a tombstone —
 *                                                    tombstones are erasure
 *                                                    cascade territory, G5)
 *   immune    ⇔ reinforcement history has >= 2 dates (the world re-confirmed
 *               the note at least once beyond its creation seed)
 *
 * semantic_facts are deliberately out of scope — they have their own
 * tombstone model (superseded_by / invalidated_at / valid_to).
 *
 * Deletion is never hard: every removed row is first snapshotted into the
 * `deleted_observations` audit table (schema v54), then deleted from
 * `observations` (the observations_ad FTS trigger cleans the index). Chroma
 * tombstoning is the caller's job, fail-soft (see the retention-sweep route).
 *
 * Nothing here runs on a timer — the sweep is invoked explicitly via
 * POST /api/maintenance/retention-sweep or `memory-eval retention-sweep`.
 */

const MS_PER_DAY = 86_400_000;
export const RETENTION_REASON = 'retention-sweep';

export interface RetentionPolicy {
  /** Master switch. Dry-run reports are always allowed; apply requires this. */
  enabled: boolean;
  minAgeDays: number;
  minStrength: number;
  maxDeletesPerRun: number;
}

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  enabled: false,
  minAgeDays: 90,
  minStrength: 0.05,
  maxDeletesPerRun: 500,
};

/**
 * Read the policy from settings.json/env, mirroring consolidationEnabled() —
 * settings win, env fills gaps, DEFAULTS last.
 */
export function readRetentionPolicy(): RetentionPolicy {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH) as unknown as Record<string, unknown>;
  const str = (key: string, fallback: string): string =>
    String(settings[key] ?? process.env[key] ?? fallback);
  const num = (key: string, fallback: number): number => {
    const v = Number(str(key, String(fallback)));
    return Number.isFinite(v) ? v : fallback;
  };
  return {
    enabled: str('CLAUDE_MEM_RETENTION_ENABLED', String(DEFAULT_RETENTION_POLICY.enabled)) === 'true',
    minAgeDays: Math.max(1, Math.floor(num('CLAUDE_MEM_RETENTION_MIN_AGE_DAYS', DEFAULT_RETENTION_POLICY.minAgeDays))),
    minStrength: Math.max(0, num('CLAUDE_MEM_RETENTION_MIN_STRENGTH', DEFAULT_RETENTION_POLICY.minStrength)),
    maxDeletesPerRun: Math.max(1, Math.floor(num('CLAUDE_MEM_RETENTION_MAX_DELETES_PER_RUN', DEFAULT_RETENTION_POLICY.maxDeletesPerRun))),
  };
}

export interface RetentionCandidate {
  id: number;
  created_at_epoch: number;
  ageDays: number;
  strength: number;
}

export interface RetentionSweepResult {
  dryRun: boolean;
  policy: RetentionPolicy;
  /** Rows passing the SQL prefilter (age + relevance + not-superseded). */
  scanned: number;
  /** Rows deleted in this run (0 for dry-run). */
  deleted: number;
  /** Audit-table batch id (null for dry-run). */
  batchId: string | null;
  /** Full snapshots of deleted rows (for Chroma tombstoning); [] for dry-run. */
  snapshots: Array<Record<string, unknown>>;
  candidates: RetentionCandidate[];
}

interface PrefilterRow {
  id: number;
  created_at_epoch: number;
  reinforcement_dates: string | null;
}

/**
 * Select retention candidates, oldest first, capped at `policy.maxDeletesPerRun`.
 * The strength filter runs in JS — ACT-R effective strength is not SQL-expressible.
 */
export function selectRetentionCandidates(
  db: Database,
  policy: RetentionPolicy,
  now: Date = new Date(),
): { candidates: RetentionCandidate[]; scanned: number } {
  const cutoffEpoch = now.getTime() - policy.minAgeDays * MS_PER_DAY;
  const rows = db.prepare(`
    SELECT id, created_at_epoch, reinforcement_dates
    FROM observations
    WHERE created_at_epoch < ?
      AND COALESCE(relevance_count, 0) = 0
      AND superseded_by IS NULL
    ORDER BY created_at_epoch ASC
  `).all(cutoffEpoch) as PrefilterRow[];

  const powerD = readTunables().powerD;
  const candidates: RetentionCandidate[] = [];
  for (const row of rows) {
    if (candidates.length >= policy.maxDeletesPerRun) break;
    const dates = parseReinforcementDates(row.reinforcement_dates);
    // Immune: the world re-confirmed this note at least once beyond its seed.
    if (dates.length >= 2) continue;
    const strength = effectiveStrength(dates, now, powerD);
    if (strength >= policy.minStrength) continue;
    candidates.push({
      id: row.id,
      created_at_epoch: row.created_at_epoch,
      ageDays: Math.floor((now.getTime() - row.created_at_epoch) / MS_PER_DAY),
      strength,
    });
  }
  return { candidates, scanned: rows.length };
}

/**
 * Run the retention sweep. Dry-run (the default everywhere) only reports
 * candidates; apply snapshots each candidate into `deleted_observations` and
 * removes it from `observations`, all in one transaction.
 */
export function runRetentionSweep(
  db: Database,
  policy: RetentionPolicy,
  options: { dryRun?: boolean; now?: Date } = {},
): RetentionSweepResult {
  const dryRun = options.dryRun !== false;
  const now = options.now ?? new Date();
  const { candidates, scanned } = selectRetentionCandidates(db, policy, now);

  const result: RetentionSweepResult = {
    dryRun,
    policy,
    scanned,
    deleted: 0,
    batchId: null,
    snapshots: [],
    candidates,
  };
  if (dryRun || candidates.length === 0) return result;

  const batchId = `retention-${now.toISOString()}-${randomUUID().slice(0, 8)}`;
  const deletedAt = now.toISOString();
  const ids = candidates.map(c => c.id);
  const placeholders = ids.map(() => '?').join(',');

  const tx = db.transaction(() => {
    const snapshots = db.prepare(
      `SELECT * FROM observations WHERE id IN (${placeholders})`,
    ).all(...ids) as Array<Record<string, unknown>>;

    const insert = db.prepare(`
      INSERT INTO deleted_observations (observation_id, snapshot_json, deleted_at, reason, batch_id)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const snapshot of snapshots) {
      insert.run(snapshot.id as number, JSON.stringify(snapshot), deletedAt, RETENTION_REASON, batchId);
    }

    db.prepare(`DELETE FROM observations WHERE id IN (${placeholders})`).run(...ids);
    result.snapshots = snapshots;
  });
  tx();

  result.deleted = result.snapshots.length;
  result.batchId = batchId;
  logger.info('RETENTION', `Retention sweep moved ${result.deleted} observation(s) to deleted_observations`, {
    batchId,
    scanned,
    minAgeDays: policy.minAgeDays,
    minStrength: policy.minStrength,
  });
  return result;
}

/**
 * Chroma document ids for a deleted observation snapshot — mirrors
 * ChromaSync.formatObservationDocs (`obs_<id>_narrative`, `obs_<id>_text`,
 * `obs_<id>_fact_<i>`). Used by callers to tombstone the vector store after
 * a sweep.
 */
export function observationChromaDocIds(snapshot: Record<string, unknown>): string[] {
  const ids: string[] = [];
  const id = snapshot.id;
  if (typeof snapshot.narrative === 'string' && snapshot.narrative) ids.push(`obs_${id}_narrative`);
  if (typeof snapshot.text === 'string' && snapshot.text) ids.push(`obs_${id}_text`);
  let facts: unknown[] = [];
  try {
    const parsed = typeof snapshot.facts === 'string' ? JSON.parse(snapshot.facts) : [];
    if (Array.isArray(parsed)) facts = parsed;
  } catch {
    // malformed facts JSON — narrative/text ids still tombstone
  }
  for (let i = 0; i < facts.length; i++) ids.push(`obs_${id}_fact_${i}`);
  return ids;
}
