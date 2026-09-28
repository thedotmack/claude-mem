/**
 * Retry guard for agent-run installs. Agents re-ran the same failing command
 * dozens of times (bun-missing-after-install averaged ~64 failures per
 * non-interactive user). `<dataDir>/install-attempts.json` counts failures per
 * error category; the second failure of the same category within 24 hours is
 * a repeat, and the result line then tells the agent re-running won't help.
 * A successful install clears every entry.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { resolveDataDir } from '../../shared/paths.js';

export const REPEAT_WINDOW_MS = 24 * 60 * 60 * 1000;
const ATTEMPTS_FILE = 'install-attempts.json';

export interface AttemptEntry {
  count: number;
  first_at: string;
  last_at: string;
}

export type AttemptLog = Record<string, AttemptEntry>;

export interface AttemptRecord {
  /** Failures of this category in the current 24-hour window, this one included. */
  attemptN: number;
  /** True from the second failure of the same category within the window. */
  isRepeat: boolean;
}

function attemptsPath(): string {
  return join(resolveDataDir(), ATTEMPTS_FILE);
}

export function readAttemptLog(): AttemptLog {
  try {
    const path = attemptsPath();
    if (!existsSync(path)) return {};
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as AttemptLog : {};
  } catch {
    // [ANTI-PATTERN IGNORED]: a corrupt counter file restarts the count; the guard is advisory.
    return {};
  }
}

/** Pure: the next log after one failure of `category` at `now`. */
export function nextAttemptLog(log: AttemptLog, category: string, now: number): { log: AttemptLog; record: AttemptRecord } {
  const previous = log[category];
  const lastAt = previous ? Date.parse(previous.last_at) : NaN;
  const inWindow = previous !== undefined && Number.isFinite(lastAt) && now - lastAt < REPEAT_WINDOW_MS;
  const iso = new Date(now).toISOString();
  const entry: AttemptEntry = inWindow
    ? { count: previous.count + 1, first_at: previous.first_at, last_at: iso }
    : { count: 1, first_at: iso, last_at: iso };
  return {
    log: { ...log, [category]: entry },
    record: { attemptN: entry.count, isRepeat: entry.count >= 2 },
  };
}

/** Whether the NEXT failure of `category` would be a repeat (used to skip a step up front). */
export function previousFailureInWindow(category: string, now: number = Date.now()): boolean {
  const entry = readAttemptLog()[category];
  if (!entry) return false;
  const lastAt = Date.parse(entry.last_at);
  return Number.isFinite(lastAt) && now - lastAt < REPEAT_WINDOW_MS;
}

export function recordFailedAttempt(category: string, now: number = Date.now()): AttemptRecord {
  const { log, record } = nextAttemptLog(readAttemptLog(), category, now);
  try {
    mkdirSync(resolveDataDir(), { recursive: true });
    writeFileSync(attemptsPath(), JSON.stringify(log, null, 2) + '\n');
  } catch {
    // [ANTI-PATTERN IGNORED]: failing to persist the counter only weakens the next run's hint; the abort itself is already reported.
  }
  return record;
}

export function clearAttempts(): void {
  try {
    rmSync(attemptsPath(), { force: true });
  } catch {
    // [ANTI-PATTERN IGNORED]: a stale counter only affects an advisory hint on the next failure.
  }
}
