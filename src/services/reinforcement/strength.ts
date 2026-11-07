// SPDX-License-Identifier: Apache-2.0

/**
 * ACT-R reinforcement history for observation memory.
 *
 * Ported from the `webdev` memory vault (`tools/mem_reinforce.py`). Every
 * observation keeps a short list of the days the world re-confirmed it; the
 * ranking in ./rank.ts turns that history into a power-law decayed strength
 * (Anderson & Schooler), so context injection can favour notes that keep being
 * re-confirmed instead of relying on recency alone. Embedding-free: strength
 * rides on a list of dates, no vector store required.
 */

const MS_PER_DAY = 86_400_000;

/** Power-law decay exponent: age^-d. 0.5 is the canonical ACT-R value. */
export const ACT_R_DECAY = 0.5;

/**
 * Reinforcement history window. Old dates fall off FIFO: the power-law decay
 * makes them contribute little anyway (spacing effect).
 */
export const MAX_REINFORCEMENT_HISTORY = 10;

/** Whole-day age between an ISO date string and `today`, clamped to >= 1. */
export function ageDays(dateISO: string, today: Date): number {
  const then = Date.parse(dateISO);
  if (Number.isNaN(then)) return 1;
  const diff = Math.floor((today.getTime() - then) / MS_PER_DAY);
  return diff < 1 ? 1 : diff;
}

/**
 * Parse the JSON-encoded `reinforcement_dates` column into a list of ISO date
 * strings. Tolerant of null / malformed values: returns [].
 */
export function parseReinforcementDates(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((d): d is string => typeof d === 'string' && d.length > 0);
  } catch {
    // [ANTI-PATTERN IGNORED]: a hand-edited or corrupt column must not break ranking; an unreadable history ranks as no reinforcement.
    return [];
  }
}

/** ISO `YYYY-MM-DD` for a date in UTC: the canonical reinforcement-date form. */
export function isoDay(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Append a day to a reinforcement-date list, FIFO-trimmed to the last
 * `maxHistory` events. Idempotent within a day: a second reinforcement on the
 * same date is a no-op that returns the input array itself.
 *
 * Idempotency is a membership check (`includes`), not a last-element check, so
 * an unsorted history (a manual edit, a future merge) cannot collect same-day
 * duplicates that would inflate strength. O(n) with n <= maxHistory.
 */
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
