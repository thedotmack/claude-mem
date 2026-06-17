// SPDX-License-Identifier: Apache-2.0

import {
  ageDays,
  parseReinforcementDates,
  readTunables,
  type ReinforcementTunables,
} from './strength.js';

/**
 * Strength-weighted ranking for context injection (Phase 2).
 *
 * claude-mem's SessionStart injection has no user prompt to keyword-match
 * against, so instead of webdev's prompt-keyword prefetch we rank by ACT-R
 * base-level activation, in which recency and reinforcement are the *same*
 * signal: the observation's creation is its first "presentation", and each
 * reinforcement is another. A note re-confirmed yesterday is current even if it
 * was created months ago — exactly the durable knowledge pure recency buries.
 *
 *   score = ln(1 + age_created^-d + ALPHA * Σ age_reinforcement^-d)
 *
 * The creation term is taken from created_at_epoch (always present); the
 * reinforcement terms are the *additional* dates beyond creation. With
 * ALPHA = 0 the score is ln(1 + age_created^-d) — monotonic in recency — so the
 * selection collapses to the legacy "top-N most recent" behaviour exactly.
 */

const MS_PER_DAY = 86_400_000;

export interface Rankable {
  created_at_epoch: number;
  reinforcement_dates?: string | null;
}

const POOL_MULT_DEFAULT = 5;
const POOL_CAP = 500;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

/**
 * How many candidates to fetch before ranking. Wider than the final count so
 * reinforced older observations have something to climb past. Bounded by
 * POOL_CAP to keep the in-JS rank cheap. A sentinel "show all" count (very
 * large) is passed through untouched.
 */
export function poolSize(count: number): number {
  if (count >= POOL_CAP) return count; // "show all" / already huge — don't shrink
  const mult = envInt('CLAUDE_MEM_REINFORCE_POOL_MULT', POOL_MULT_DEFAULT);
  return Math.min(POOL_CAP, Math.max(count, count * mult));
}

/** Power-law decay of an epoch-ms timestamp's age in days (today ≈ 1). */
function recencyWeight(epochMs: number, today: Date, powerD: number): number {
  const age = Math.max(1, Math.floor((today.getTime() - epochMs) / MS_PER_DAY));
  return Math.pow(age, -powerD);
}

export function blendedScore(
  item: Rankable,
  today: Date,
  tunables: ReinforcementTunables,
): number {
  const created = recencyWeight(item.created_at_epoch, today, tunables.powerD);

  // Reinforcement terms = dates beyond the seeded creation day (the first entry).
  // created_at_epoch already supplies the creation term, so we skip dates[0] to
  // avoid double-counting it.
  const dates = parseReinforcementDates(item.reinforcement_dates);
  let reinforcementSum = 0;
  for (let k = 1; k < dates.length; k++) {
    reinforcementSum += Math.pow(ageDays(dates[k], today), -tunables.powerD);
  }

  return Math.log(1 + created + tunables.alpha * reinforcementSum);
}

/**
 * Re-rank a recency-ordered candidate pool by blended score, keep the top
 * `count`, and return them re-sorted newest-first so downstream consumers
 * (mostRecentObservation, timeline, prior-message lookup) see the ordering they
 * expect.
 *
 * Stable: ties break by recency, then original pool position.
 */
export function rankByStrength<T extends Rankable>(
  pool: T[],
  count: number,
  today: Date = new Date(),
  tunables: ReinforcementTunables = readTunables(),
): T[] {
  // Nothing to drop, and no reordering when reinforcement is disabled.
  if (pool.length <= count && tunables.alpha === 0) return pool;

  const scored = pool.map((item, i) => ({ item, i, score: blendedScore(item, today, tunables) }));
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      b.item.created_at_epoch - a.item.created_at_epoch ||
      a.i - b.i,
  );
  const top = scored.slice(0, count).map(s => s.item);
  top.sort((a, b) => b.created_at_epoch - a.created_at_epoch);
  return top;
}
