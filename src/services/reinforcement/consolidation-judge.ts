// SPDX-License-Identifier: Apache-2.0

import type { Database } from 'bun:sqlite';
import { logger } from '../../utils/logger.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { blendedScore } from './rank.js';
import { readTunables } from './strength.js';
import { createSdkJudge } from './dedup-judge.js';
import type { JudgeFn } from './dedup.js';
import {
  buildConsolidationPrompt,
  parseConsolidationVerdicts,
  type ConsolidationFactInput,
  type ConsolidationObservationInput,
} from './consolidation.js';
import {
  getActiveFacts,
  insertFact,
  supersedeFact,
  invalidateFact,
  isFactKind,
  type SemanticFactRow,
} from '../sqlite/facts/store.js';

/**
 * Semantic memory layer — consolidation job wiring (opt-in, default OFF).
 *
 * Triggered worker-side after a session's summary is stored, throttled per
 * project. ⚠️ Each run costs one LLM call, so the master switch
 * `CLAUDE_MEM_CONSOLIDATION_ENABLED=true` is off by default (same policy as
 * the dedup judge). The whole pass is defensive: any failure — LLM error,
 * malformed verdicts, DB hiccup — degrades to a NOOP and never disturbs the
 * storage pipeline.
 */

export function consolidationEnabled(): boolean {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH) as unknown as Record<string, unknown>;
  const raw = settings.CLAUDE_MEM_CONSOLIDATION_ENABLED ?? process.env.CLAUDE_MEM_CONSOLIDATION_ENABLED;
  return String(raw ?? '') === 'true';
}

export interface ConsolidationThresholds {
  minIntervalHours: number;
  minObservations: number;
}

function readNumberSetting(name: string, fallback: number): number {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH) as unknown as Record<string, unknown>;
  const raw = settings[name] ?? process.env[name];
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function getConsolidationThresholds(): ConsolidationThresholds {
  return {
    minIntervalHours: readNumberSetting('CLAUDE_MEM_CONSOLIDATE_MIN_INTERVAL_HOURS', 12),
    minObservations: readNumberSetting('CLAUDE_MEM_CONSOLIDATE_MIN_OBSERVATIONS', 20),
  };
}

interface ConsolidationStateRow {
  project: string;
  last_run_at_epoch: number;
  last_observation_id: number;
}

function getConsolidationState(db: Database, project: string): ConsolidationStateRow | null {
  try {
    return (db
      .prepare('SELECT project, last_run_at_epoch, last_observation_id FROM semantic_consolidation_state WHERE project = ?')
      .get(project) as ConsolidationStateRow | undefined) ?? null;
  } catch {
    return null; // pre-v53 database — treat as never consolidated
  }
}

function recordConsolidationRun(db: Database, project: string, runAtEpoch: number, lastObservationId: number): void {
  db.prepare(`
    INSERT INTO semantic_consolidation_state (project, last_run_at_epoch, last_observation_id)
    VALUES (?, ?, ?)
    ON CONFLICT(project) DO UPDATE SET last_run_at_epoch = excluded.last_run_at_epoch,
                                       last_observation_id = excluded.last_observation_id
  `).run(project, runAtEpoch, lastObservationId);
}

export interface ThrottleDecision {
  ok: boolean;
  reason: string;
  newObservations: number;
  sinceObservationId: number;
}

/**
 * Per-project throttle: consolidation runs at most once per
 * `minIntervalHours` and only once at least `minObservations` new
 * observations have landed since the last run's watermark.
 */
export function shouldConsolidate(
  db: Database,
  project: string,
  thresholds: ConsolidationThresholds = getConsolidationThresholds(),
  now: Date = new Date(),
): ThrottleDecision {
  const state = getConsolidationState(db, project);
  const sinceObservationId = state?.last_observation_id ?? 0;

  let newObservations = 0;
  try {
    const row = db
      .prepare('SELECT COUNT(*) AS count FROM observations WHERE project = ? AND id > ?')
      .get(project, sinceObservationId) as { count: number } | undefined;
    newObservations = row?.count ?? 0;
  } catch {
    return { ok: false, reason: 'observation count query failed', newObservations: 0, sinceObservationId };
  }

  if (state && thresholds.minIntervalHours > 0) {
    const elapsedMs = now.getTime() - state.last_run_at_epoch;
    if (elapsedMs < thresholds.minIntervalHours * 3_600_000) {
      return { ok: false, reason: 'min interval not elapsed', newObservations, sinceObservationId };
    }
  }

  if (newObservations < thresholds.minObservations) {
    return { ok: false, reason: 'not enough new observations', newObservations, sinceObservationId };
  }

  return { ok: true, reason: 'thresholds met', newObservations, sinceObservationId };
}

/** New observations since the watermark — the episodes to distill. */
function fetchNewObservations(
  db: Database,
  project: string,
  sinceObservationId: number,
  limit = 100,
): ConsolidationObservationInput[] {
  return db.prepare(`
    SELECT id, title, narrative, concepts
    FROM observations
    WHERE project = ? AND id > ? AND superseded_by IS NULL
    ORDER BY id ASC
    LIMIT ?
  `).all(project, sinceObservationId, limit) as ConsolidationObservationInput[];
}

/** Active facts for the prompt, capped, strongest first. */
function fetchFactsForPrompt(db: Database, project: string, limit = 50): SemanticFactRow[] {
  const pool = getActiveFacts(db, [project], limit * 3);
  const tunables = readTunables();
  const today = new Date();
  return pool
    .map(fact => ({ fact, score: blendedScore(fact, today, tunables) }))
    .sort((a, b) => b.score - a.score || b.fact.created_at_epoch - a.fact.created_at_epoch)
    .slice(0, limit)
    .map(entry => entry.fact);
}

export interface ConsolidationSummary {
  ran: boolean;
  reason?: string;
  added: number;
  updated: number;
  deleted: number;
  noop: boolean;
  rejected: string[];
}

const IDLE: Omit<ConsolidationSummary, 'ran' | 'reason'> = {
  added: 0,
  updated: 0,
  deleted: 0,
  noop: false,
  rejected: [],
};

/**
 * Apply parsed verdicts to the store. Each verdict is applied independently —
 * a failing verdict is logged and skipped, never aborts the rest.
 */
function applyVerdicts(
  db: Database,
  project: string,
  verdicts: ReturnType<typeof parseConsolidationVerdicts>['verdicts'],
  now: Date,
): Pick<ConsolidationSummary, 'added' | 'updated' | 'deleted' | 'noop'> {
  let added = 0;
  let updated = 0;
  let deleted = 0;
  let noop = false;

  for (const verdict of verdicts) {
    try {
      switch (verdict.action) {
        case 'NOOP':
          noop = true;
          break;
        case 'ADD': {
          insertFact(db, { project, kind: verdict.kind, fact: verdict.fact, sourceObservationIds: verdict.sourceIds }, now);
          added++;
          break;
        }
        case 'UPDATE': {
          // The verdict carries no kind — the corrected fact inherits the old row's.
          const old = db.prepare('SELECT kind FROM semantic_facts WHERE id = ?').get(verdict.targetFactId) as { kind: string } | undefined;
          const kind = old && isFactKind(old.kind) ? old.kind : 'project_convention';
          const { id: newId } = insertFact(db, { project, kind, fact: verdict.fact, sourceObservationIds: verdict.sourceIds }, now);
          if (newId !== verdict.targetFactId && supersedeFact(db, verdict.targetFactId, newId, now)) {
            updated++;
          }
          break;
        }
        case 'DELETE': {
          if (invalidateFact(db, verdict.targetFactId, now)) deleted++;
          break;
        }
      }
    } catch (error) {
      logger.warn('CONSOLIDATION', `Verdict ${verdict.action} failed — skipped`, {}, error instanceof Error ? error : new Error(String(error)));
    }
  }

  return { added, updated, deleted, noop };
}

/**
 * Run one consolidation pass for a project: throttle check → gather active
 * facts + new observations → judge → apply verdicts → record the run. Any
 * failure short-circuits to a NOOP summary; the run is still recorded so a
 * broken judge doesn't retry every session.
 */
export async function runConsolidation(
  db: Database,
  project: string,
  judge: JudgeFn = createSdkJudge(),
  now: Date = new Date(),
  opts: { force?: boolean } = {},
): Promise<ConsolidationSummary> {
  if (!opts.force) {
    const decision = shouldConsolidate(db, project, getConsolidationThresholds(), now);
    if (!decision.ok) {
      return { ran: false, reason: decision.reason, ...IDLE };
    }
  }

  let facts: SemanticFactRow[];
  let observations: ConsolidationObservationInput[];
  let sinceObservationId: number;
  try {
    sinceObservationId = getConsolidationState(db, project)?.last_observation_id ?? 0;
    facts = fetchFactsForPrompt(db, project);
    observations = fetchNewObservations(db, project, sinceObservationId);
  } catch (error) {
    logger.warn('CONSOLIDATION', 'Input gathering failed — NOOP', { project }, error instanceof Error ? error : new Error(String(error)));
    return { ran: false, reason: 'input gathering failed', ...IDLE };
  }

  if (observations.length === 0) {
    recordConsolidationRun(db, project, now.getTime(), sinceObservationId);
    return { ran: false, reason: 'no new observations', ...IDLE };
  }

  const promptInput: ConsolidationFactInput[] = facts.map(f => ({ id: f.id, kind: f.kind, fact: f.fact }));

  let summary: ConsolidationSummary;
  try {
    const raw = await judge(buildConsolidationPrompt(promptInput, observations));
    const parsed = parseConsolidationVerdicts(raw, {
      factIds: new Set(facts.map(f => f.id)),
      observationIds: new Set(observations.map(o => o.id)),
    });
    for (const reason of parsed.rejected) {
      logger.warn('CONSOLIDATION', `Verdict rejected: ${reason}`, { project });
    }
    summary = { ran: true, ...IDLE, ...applyVerdicts(db, project, parsed.verdicts, now), rejected: parsed.rejected };
  } catch (error) {
    logger.warn('CONSOLIDATION', 'Judge call failed — NOOP', { project }, error instanceof Error ? error : new Error(String(error)));
    summary = { ran: false, reason: 'judge error', ...IDLE };
  }

  try {
    const lastObservationId = Math.max(sinceObservationId, ...observations.map(o => o.id));
    recordConsolidationRun(db, project, now.getTime(), lastObservationId);
  } catch (error) {
    logger.warn('CONSOLIDATION', 'Failed to record consolidation run', { project }, error instanceof Error ? error : new Error(String(error)));
  }

  if (summary.ran) {
    logger.info('CONSOLIDATION', `Consolidated ${project}: +${summary.added} ~${summary.updated} -${summary.deleted}${summary.noop ? ' noop' : ''}`);
  }
  return summary;
}

/**
 * Post-store entry point (ResponseProcessor). Master-gated; returns null when
 * consolidation is disabled. Never throws.
 */
export async function maybeConsolidate(
  db: Database,
  project: string,
  judge?: JudgeFn,
  now: Date = new Date(),
): Promise<ConsolidationSummary | null> {
  if (!consolidationEnabled()) return null;
  try {
    return await runConsolidation(db, project, judge ?? createSdkJudge(), now);
  } catch (error) {
    logger.warn('CONSOLIDATION', 'Consolidation pass failed — NOOP', { project }, error instanceof Error ? error : new Error(String(error)));
    return null;
  }
}
