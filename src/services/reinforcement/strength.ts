// SPDX-License-Identifier: Apache-2.0

/**
 * ACT-R base-level activation for observation memory.
 *
 * Ported from the `webdev` memory vault (`tools/mem_reinforce.py` /
 * `tools/memory_prefetch.py`). The idea: every observation has a *strength*
 * that grows each time the world re-confirms it and decays with time by a
 * power law. Strength biases context-injection ranking toward notes the world
 * keeps re-confirming, instead of the recency-only `ORDER BY created_at_epoch`
 * the worker uses today.
 *
 * Deliberately embedding-free — strength rides on a list of reinforcement
 * dates, no vector store required.
 *
 * Reference formula (POWER_D = 0.5, Anderson & Schooler's canonical value):
 *
 *   effective_strength = ln(1 + Σ max(1, age_k)^-d)   over reinforcement dates
 *                        0                             for an empty list
 *
 *   age_k = (today - date_k) in days, clamped to >= 1
 */

const MS_PER_DAY = 86_400_000;

export interface ReinforcementTunables {
  /** Weight of reinforcement strength on rank. Higher → strong notes dominate sooner. */
  alpha: number;
  /** Weight of past-retrieval count (self-reinforcement of surfaced notes). */
  beta: number;
  /** Power-law decay exponent. age^-d. 0.5 is the canonical ACT-R value. */
  powerD: number;
  /** How far back (days) past surfacings are counted. */
  retrievalWindowDays: number;
}

export const DEFAULT_TUNABLES: ReinforcementTunables = {
  alpha: 0.5,
  beta: 0.1,
  powerD: 0.5,
  retrievalWindowDays: 30,
};

function envFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

/**
 * Read tunables from the environment, mirroring the `CLAUDE_MEM_*` convention.
 * Set ALPHA=0 and BETA=0 to disable the reinforcement bias entirely without a
 * redeploy (ranking falls back to pure keyword/recency behaviour).
 */
export function readTunables(): ReinforcementTunables {
  const powerD = envFloat('CLAUDE_MEM_REINFORCE_POWER_D', DEFAULT_TUNABLES.powerD);
  return {
    alpha: envFloat('CLAUDE_MEM_REINFORCE_ALPHA', DEFAULT_TUNABLES.alpha),
    beta: envFloat('CLAUDE_MEM_REINFORCE_BETA', DEFAULT_TUNABLES.beta),
    // A non-positive exponent would invert decay — fall back to the default.
    powerD: powerD > 0 ? powerD : DEFAULT_TUNABLES.powerD,
    retrievalWindowDays: envFloat(
      'CLAUDE_MEM_REINFORCE_RETRIEVAL_WINDOW_DAYS',
      DEFAULT_TUNABLES.retrievalWindowDays,
    ),
  };
}

/** Whole-day age between an ISO date string and `today`, clamped to >= 1. */
export function ageDays(dateISO: string, today: Date): number {
  const then = Date.parse(dateISO);
  if (Number.isNaN(then)) return 1;
  const diff = Math.floor((today.getTime() - then) / MS_PER_DAY);
  return diff < 1 ? 1 : diff;
}

/**
 * Parse the JSON-encoded `reinforcement_dates` column into a list of ISO date
 * strings. Tolerant of null / malformed values — returns [].
 */
export function parseReinforcementDates(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((d): d is string => typeof d === 'string' && d.length > 0);
  } catch {
    return [];
  }
}

/**
 * Base-level activation: ln(1 + Σ max(1, age)^-d).
 *
 * The inner sum is the power-law decayed contribution of each reinforcement
 * event; +1 is Laplace smoothing so a single stale event never drives the
 * score below baseline; the outer ln gives sublinear compression (10 events
 * are not 10× one event).
 *
 * Calibration (d = 0.5):
 *   []                  → 0
 *   [today]             → ln(2)  ≈ 0.693
 *   [today] × 10        → ln(11) ≈ 2.398
 *   [today-30]          → ln(1 + 30^-0.5) ≈ 0.167
 */
export function effectiveStrength(
  dates: string[],
  today: Date = new Date(),
  powerD: number = DEFAULT_TUNABLES.powerD,
): number {
  if (dates.length === 0) return 0;
  let sum = 0;
  for (const d of dates) {
    sum += Math.pow(ageDays(d, today), -powerD);
  }
  return Math.log(1 + sum);
}

export interface RelevanceInput {
  /** Keyword/FTS match component (already weighted by the caller). */
  keywordScore: number;
  /** Optional structural bonus (type match, recency tie-break, …). */
  bonus?: number;
  /** Effective strength from `effectiveStrength`. */
  strength: number;
  /** How often this observation has surfaced in past prefetches. */
  retrievalCount?: number;
}

/**
 * Final ranking score for context injection:
 *
 *   score = (keyword*2 + bonus) * (1 + ALPHA * strength) + BETA * log1p(retrieval)
 *
 * Strength is a *multiplier* on relevance, not an additive term — a note still
 * has to match the current prompt to surface; reinforcement only re-orders
 * among things that already match.
 */
export function relevanceScore(
  input: RelevanceInput,
  tunables: ReinforcementTunables = DEFAULT_TUNABLES,
): number {
  const base = input.keywordScore * 2 + (input.bonus ?? 0);
  const retrieval = Math.max(0, input.retrievalCount ?? 0);
  return base * (1 + tunables.alpha * input.strength) + tunables.beta * Math.log1p(retrieval);
}

/** ISO `YYYY-MM-DD` for a date in UTC — the canonical reinforcement-date form. */
export function isoDay(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Append today's date to a reinforcement-date list, FIFO-trimmed to the last
 * `maxHistory` events (the spacing-effect window). Idempotent within a day:
 * a second reinforcement on the same date is a no-op.
 *
 * Idempotency is a membership check (`includes`), NOT a last-element check:
 * the old tail comparison silently relied on the array always being sorted —
 * one unsorted migration / cross-device merge / manual edit and same-day
 * duplicates slip through, inflating strength. O(n) with n ≤ maxHistory.
 */
export const MAX_REINFORCEMENT_HISTORY = 10;

export function appendReinforcement(
  dates: string[],
  today: Date = new Date(),
  maxHistory: number = MAX_REINFORCEMENT_HISTORY,
): string[] {
  const day = isoDay(today);
  if (dates.includes(day)) return dates;
  const next = [...dates, day];
  return next.length > maxHistory ? next.slice(next.length - maxHistory) : next;
}
