// SPDX-License-Identifier: Apache-2.0

import { ACT_R_DECAY, ageDays, parseReinforcementDates } from './strength.js';

/**
 * Strength-weighted selection for SessionStart context injection (opt-in).
 *
 * SessionStart has no prompt to match against, so candidates are ranked by
 * ACT-R base-level activation, where recency and reinforcement are the same
 * signal: an observation's creation is its first "presentation" and each
 * reinforcement day is another. A note re-confirmed yesterday stays current
 * even if it was created months ago — the durable knowledge pure recency buries.
 *
 *   score = ln(1 + age_created^-d + ALPHA * Σ age_reinforcement^-d)
 *
 * ALPHA comes from CLAUDE_MEM_REINFORCE_ALPHA (settings.json, default 0). With
 * ALPHA = 0 ranking is off: the candidate pool is exactly the configured count
 * and the selection is the legacy "N most recent", unchanged.
 */

const MS_PER_DAY = 86_400_000;

/** How much wider than the final count the candidate pool is when ranking is on. */
const POOL_MULTIPLIER = 5;
/** Upper bound on the pool, keeping the in-JS rank cheap. */
const POOL_CAP = 500;

export interface Rankable {
  created_at_epoch: number;
  reinforcement_dates?: string | null;
}

/**
 * How many recency-ordered candidates to fetch. Wider than `count` when ranking
 * is on, so reinforced older observations have something to climb past;
 * exactly `count` when it is off. A count at or above the cap (a "show all"
 * sentinel) passes through untouched.
 */
export function poolSize(count: number, alpha: number): number {
  if (!(alpha > 0) || count >= POOL_CAP) return count;
  return Math.min(POOL_CAP, Math.max(count, count * POOL_MULTIPLIER));
}

/** Power-law decay of an epoch-ms timestamp's age in days (today ≈ 1). */
function recencyWeight(epochMs: number, today: Date): number {
  const age = Math.max(1, Math.floor((today.getTime() - epochMs) / MS_PER_DAY));
  return Math.pow(age, -ACT_R_DECAY);
}

export function blendedScore(item: Rankable, today: Date, alpha: number): number {
  const created = recencyWeight(item.created_at_epoch, today);

  // Reinforcement terms are the dates beyond the seeded creation day (the
  // first entry): created_at_epoch already supplies the creation term.
  const dates = parseReinforcementDates(item.reinforcement_dates);
  let reinforcementSum = 0;
  for (let k = 1; k < dates.length; k++) {
    reinforcementSum += Math.pow(ageDays(dates[k], today), -ACT_R_DECAY);
  }

  return Math.log(1 + created + alpha * reinforcementSum);
}

/**
 * Rows at the head of the window that are always kept, newest first. The
 * last-summary check compares the newest summary with the newest observation,
 * and the prior-session lookup walks the newest rows; if reinforced older rows
 * could displace them, a stale summary would render as current. So
 * reinforcement only re-ranks the older part of the window.
 */
export function recencyHeadSize(count: number): number {
  return Math.max(1, Math.ceil(count / 4));
}

/**
 * Select `count` observations from a pool ordered newest first (the query's
 * `ORDER BY created_at_epoch DESC`): the recency head is kept as is, the
 * remaining slots go to the highest blended scores, and the result is
 * returned newest first so downstream consumers (timeline, summary check,
 * prior-session lookup) see the ordering they expect.
 *
 * Stable: ties break by recency, then pool position.
 */
export function rankByStrength<T extends Rankable>(
  pool: T[],
  count: number,
  alpha: number,
  today: Date = new Date(),
): T[] {
  if (pool.length <= count) return pool;
  if (!(alpha > 0)) return pool.slice(0, count);

  const head = pool.slice(0, Math.min(count, recencyHeadSize(count)));
  const scored = pool
    .slice(head.length)
    .map((item, i) => ({ item, i, score: blendedScore(item, today, alpha) }));
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      b.item.created_at_epoch - a.item.created_at_epoch ||
      a.i - b.i,
  );
  const kept = [...head, ...scored.slice(0, count - head.length).map(s => s.item)];
  return kept.sort((a, b) => b.created_at_epoch - a.created_at_epoch);
}
