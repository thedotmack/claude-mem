// SPDX-License-Identifier: Apache-2.0

/**
 * File-backed observer pipeline health, so "observations are not flowing" is
 * never silent (the 2026-08-09 provider-quota outage ran 17 hours unnoticed).
 *
 * The worker records generator failures (SessionRoutes generator catch) and
 * successful stores (ResponseProcessor). Session-start context assembly
 * (ContextBuilder) reads the file and prepends a loud warning when the
 * observer is unhealthy. A file — not the in-memory dependency-health map —
 * because the state must survive worker restarts and be readable from any
 * process without the worker HTTP API (same pattern as the oauth-stale
 * marker in oauth-token.ts).
 */

import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { paths } from './paths.js';
import { logger } from '../utils/logger.js';

export interface ObserverHealthState {
  /** Failures since the last successful store. */
  consecutiveFailures: number;
  /** Epoch ms of the first failure in the current streak. */
  failingSinceAt: number | null;
  /** Epoch ms of the most recent failure. */
  lastErrorAt: number | null;
  /** Scrubbed + truncated message of the most recent failure. */
  lastErrorMessage: string | null;
  /** Provider whose generator failed most recently. */
  lastErrorProvider: string | null;
  /** Epoch ms of the most recent successful observation/summary store. */
  lastSuccessAt: number | null;
}

export const OBSERVER_HEALTH_FILENAME = 'observer-health.json';

/** Warn only after repeated failures — a single blip self-heals on retry. */
export const OBSERVER_UNHEALTHY_FAILURE_THRESHOLD = 3;

const MAX_ERROR_MESSAGE_LENGTH = 600;

const EMPTY_STATE: ObserverHealthState = {
  consecutiveFailures: 0,
  failingSinceAt: null,
  lastErrorAt: null,
  lastErrorMessage: null,
  lastErrorProvider: null,
  lastSuccessAt: null,
};

function defaultHealthFilePath(): string {
  return join(paths.dataDir(), OBSERVER_HEALTH_FILENAME);
}

/**
 * Names that carry a secret when they appear as `name=value`, `name: value`,
 * or `"name": "value"` — the shapes provider errors echo back from request
 * bodies, query strings, and header dumps.
 */
const CREDENTIAL_ASSIGNMENT_PATTERN =
  /(["']?\b(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|client[_-]?secret|secret[_-]?key|secret|password|passwd|pwd|authorization|auth|token|key)\b["']?\s*[=:]\s*)(["']?)([^\s"'&,;}\]]+)\2/gi;

/**
 * Keep the message useful (provider errors often embed the remedy, e.g. an
 * OpenRouter manage-key URL) while dropping anything credential-shaped.
 *
 * Applied before persistence AND again at render time, so a ledger written by
 * an older build cannot inject a secret into session-start context.
 */
export function scrubErrorMessage(message: string): string {
  return message
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-…')
    .replace(/\b(Bearer|Basic|Digest|Token)\s+[^\s"']+/gi, '$1 …')
    // Numbers are limits/counts, not credentials — `max_tokens: 200000` and
    // `key limit exceeded` style diagnostics survive intact.
    .replace(CREDENTIAL_ASSIGNMENT_PATTERN, (match, prefix: string, quote: string, value: string) =>
      /^\d+$/.test(value) ? match : `${prefix}${quote}…${quote}`)
    .slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

export function readObserverHealth(filePath: string = defaultHealthFilePath()): ObserverHealthState | null {
  try {
    if (!existsSync(filePath)) return null;
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf-8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    return { ...EMPTY_STATE, ...(parsed as Partial<ObserverHealthState>) };
  } catch (error) {
    logger.warn('SESSION', 'Failed to read observer-health file', { filePath },
      error instanceof Error ? error : new Error(String(error)));
    return null;
  }
}

function writeObserverHealth(state: ObserverHealthState, filePath: string): void {
  try {
    const dir = join(filePath, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(filePath, JSON.stringify(state, null, 2), { encoding: 'utf-8', mode: 0o600 });
  } catch (error) {
    logger.warn('SESSION', 'Failed to write observer-health file', { filePath },
      error instanceof Error ? error : new Error(String(error)));
  }
}

/** A holder that has not released within this window is presumed dead. */
const LEDGER_LOCK_STALE_MS = 5_000;
/** Give up waiting and update unlocked rather than lose the failure entirely. */
const LEDGER_LOCK_MAX_WAIT_MS = 2_000;
const LEDGER_LOCK_RETRY_MS = 10;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Serialize the ledger's read-modify-write across processes. Every worker and
 * hook process shares one file, and lost increments would hold
 * consecutiveFailures below the threshold — suppressing the very warning this
 * module exists to raise.
 *
 * `wx` (O_CREAT|O_EXCL) makes the create itself the atomicity, matching
 * worker-spawn-gate.ts. The lock fails OPEN (unlocked update) when the
 * filesystem refuses it or the wait times out: a racy count beats no count.
 */
function withLedgerLock<T>(filePath: string, mutate: () => T): T {
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + LEDGER_LOCK_MAX_WAIT_MS;
  let held = false;

  while (!held && Date.now() < deadline) {
    try {
      mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
      writeFileSync(lockPath, String(process.pid), { flag: 'wx', mode: 0o600 });
      held = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        logger.warn('SESSION', 'Observer-health lock unavailable; updating unlocked', { lockPath, code },
          error instanceof Error ? error : new Error(String(error)));
        break;
      }
      let mtimeMs: number;
      try {
        mtimeMs = statSync(lockPath).mtimeMs;
      } catch {
        // Holder released between our failed create and the stat — retry.
        continue;
      }
      if (Date.now() - mtimeMs > LEDGER_LOCK_STALE_MS) {
        try {
          unlinkSync(lockPath);
        } catch {
          // A competing breaker won, or the fs refused the delete; the retry
          // loop re-evaluates either way.
        }
        continue;
      }
      sleepSync(LEDGER_LOCK_RETRY_MS);
    }
  }

  if (!held && Date.now() >= deadline) {
    logger.warn('SESSION', 'Timed out waiting for the observer-health lock; updating unlocked', { lockPath });
  }

  try {
    return mutate();
  } finally {
    if (held) {
      try {
        unlinkSync(lockPath);
      } catch {
        // Already broken as stale by a waiter — nothing to release.
      }
    }
  }
}

export function recordObserverFailure(
  provider: string,
  errorMessage: string,
  filePath: string = defaultHealthFilePath(),
): void {
  withLedgerLock(filePath, () => {
    const prior = readObserverHealth(filePath) ?? EMPTY_STATE;
    const now = Date.now();
    writeObserverHealth({
      ...prior,
      consecutiveFailures: prior.consecutiveFailures + 1,
      failingSinceAt: prior.consecutiveFailures > 0 ? prior.failingSinceAt : now,
      lastErrorAt: now,
      lastErrorMessage: scrubErrorMessage(errorMessage),
      lastErrorProvider: provider,
    }, filePath);
  });
}

export function recordObserverSuccess(filePath: string = defaultHealthFilePath()): void {
  withLedgerLock(filePath, () => {
    const prior = readObserverHealth(filePath) ?? EMPTY_STATE;
    writeObserverHealth({
      ...prior,
      consecutiveFailures: 0,
      failingSinceAt: null,
      lastSuccessAt: Date.now(),
    }, filePath);
  });
}

export function isObserverUnhealthy(state: ObserverHealthState | null): state is ObserverHealthState {
  return state !== null
    && state.consecutiveFailures >= OBSERVER_UNHEALTHY_FAILURE_THRESHOLD
    && (state.lastErrorAt ?? 0) > (state.lastSuccessAt ?? 0);
}

/** "3 minutes" / "about 2 hours" / "about 3 days" for outage durations. */
export function describeDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `about ${hours} hour${hours === 1 ? '' : 's'}`;
  return `about ${Math.round(hours / 24)} days`;
}

/**
 * The block prepended to session-start context when unhealthy. Read by both
 * the user and the agent, so it stays calm and plain-spoken — but the agent
 * must still relay the outage (and the remedy embedded in the provider's
 * error message) to the user immediately.
 */
export function renderObserverHealthWarning(state: ObserverHealthState, nowMs: number = Date.now()): string {
  const since = state.failingSinceAt ?? state.lastErrorAt;
  const sinceText = since
    ? `for ${describeDuration(nowMs - since)} (since ${new Date(since).toISOString()})`
    : 'for an unknown amount of time';
  const provider = state.lastErrorProvider ?? 'unknown provider';
  const count = state.consecutiveFailures;
  const lines = [
    "⚠️ Heads up: claude-mem can't save memories right now.",
    '',
    `The memory observer (provider: ${provider}) has failed ${count} time${count === 1 ? '' : 's'} in a row ${sinceText}.`,
    '',
    `Latest error: ${state.lastErrorMessage ? scrubErrorMessage(state.lastErrorMessage) : 'unknown'}`,
    '',
    "Until it's fixed, nothing from this session — or any other — will be remembered.",
    "To fix it, check the observer provider's API key, spend limit, and base URL in",
    '~/.claude-mem/settings.json. The error above may include a management link with the remedy.',
    '',
    '(Assistant: please tell the user about this outage at the very start of your first reply,',
    'quoting the error above.)',
  ];
  return lines.join('\n');
}
