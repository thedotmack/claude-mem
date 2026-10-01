/**
 * Persistent, cross-process self-heal restart budget for the Claude CLI
 * stale-spawn wedge (issue #3290).
 *
 * When a long-running worker can no longer `posix_spawn` the `claude` CLI
 * after Claude Code's native auto-updater swaps the binary underneath it,
 * the CLI is present and valid on disk but `execFileSync` from the wedged
 * worker throws ENOENT forever. Only a fresh process can recover. The
 * SessionRoutes layer detects this (via ClaudeExecutableUnspawnableError)
 * and self-restarts the worker — but a genuinely broken install must not
 * thrash. This module bounds the restarts: at most
 * {@link SELF_HEAL_MAX_ATTEMPTS} attempts within a sliding
 * {@link SELF_HEAL_WINDOW_MS} window, persisted to disk so a restart loop
 * across worker generations cannot exceed the budget.
 *
 * All IO here is best-effort: every read/write swallows errors and degrades
 * to an empty budget. Persisting self-heal state must never break the worker.
 *
 * The budget clears on every successful CLI resolution — including the
 * successor worker's own boot — so each distinct wedge (at most one per CLI
 * auto-update) gets a fresh budget. The cap therefore only bites when a fresh
 * process cannot resolve the CLI either (genuinely broken install), which is
 * exactly the case that must not thrash.
 */

import fs from 'fs';
import path from 'path';
import { DATA_DIR } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';

const SELF_HEAL_STATE_PATH = path.join(DATA_DIR, 'state', 'claude-cli-selfheal.json');
export const SELF_HEAL_WINDOW_MS = 60 * 60_000;   // 1 hour
export const SELF_HEAL_MAX_ATTEMPTS = 3;

interface SelfHealState { attempts: number[]; }

function readAttempts(): number[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(SELF_HEAL_STATE_PATH, 'utf8')) as SelfHealState;
    return Array.isArray(parsed?.attempts)
      ? parsed.attempts.filter(n => typeof n === 'number' && Number.isFinite(n))
      : [];
  } catch { return []; }
}
function writeAttempts(attempts: number[]): void {
  const tmp = `${SELF_HEAL_STATE_PATH}.tmp`;
  try {
    fs.mkdirSync(path.dirname(SELF_HEAL_STATE_PATH), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ attempts }), 'utf-8');
    fs.renameSync(tmp, SELF_HEAL_STATE_PATH);
  } catch (e) {
    logger.warn('WORKER', 'Failed to persist Claude CLI self-heal state', {}, e instanceof Error ? e : new Error(String(e)));
  }
}
function prune(attempts: number[], nowMs: number): number[] {
  return attempts.filter(t => nowMs - t < SELF_HEAL_WINDOW_MS);
}

export function claudeCliSelfHealAttemptsInWindow(nowMs: number = Date.now()): number {
  return prune(readAttempts(), nowMs).length;
}
export function canAttemptClaudeCliSelfHeal(nowMs: number = Date.now()): boolean {
  return claudeCliSelfHealAttemptsInWindow(nowMs) < SELF_HEAL_MAX_ATTEMPTS;
}
export function recordClaudeCliSelfHealAttempt(nowMs: number = Date.now()): number {
  const attempts = prune(readAttempts(), nowMs);
  attempts.push(nowMs);
  writeAttempts(attempts);
  return attempts.length;
}
export function clearClaudeCliSelfHealAttempts(): void {
  try { fs.rmSync(SELF_HEAL_STATE_PATH, { force: true }); } catch { /* best effort */ }
}
