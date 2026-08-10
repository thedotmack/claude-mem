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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
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
 * Keep the message useful (provider errors often embed the remedy, e.g. an
 * OpenRouter manage-key URL) while dropping anything credential-shaped.
 */
export function scrubErrorMessage(message: string): string {
  return message
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-…')
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer …')
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

export function recordObserverFailure(
  provider: string,
  errorMessage: string,
  filePath: string = defaultHealthFilePath(),
): void {
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
}

export function recordObserverSuccess(filePath: string = defaultHealthFilePath()): void {
  const prior = readObserverHealth(filePath) ?? EMPTY_STATE;
  writeObserverHealth({
    ...prior,
    consecutiveFailures: 0,
    failingSinceAt: null,
    lastSuccessAt: Date.now(),
  }, filePath);
}

export function isObserverUnhealthy(state: ObserverHealthState | null): state is ObserverHealthState {
  return state !== null
    && state.consecutiveFailures >= OBSERVER_UNHEALTHY_FAILURE_THRESHOLD
    && (state.lastErrorAt ?? 0) > (state.lastSuccessAt ?? 0);
}

/**
 * The block prepended to session-start context when unhealthy. Written for the
 * agent: it must relay the outage (and the remedy embedded in the provider's
 * error message) to the user immediately.
 */
export function renderObserverHealthWarning(state: ObserverHealthState): string {
  const since = state.failingSinceAt ?? state.lastErrorAt;
  const sinceText = since ? new Date(since).toISOString() : 'unknown time';
  const provider = state.lastErrorProvider ?? 'unknown provider';
  const lines = [
    '⚠️ CLAUDE-MEM OBSERVER IS FAILING — NEW OBSERVATIONS ARE NOT BEING RECORDED ⚠️',
    '',
    `The memory observer (provider: ${provider}) has failed ${state.consecutiveFailures} consecutive times since ${sinceText}.`,
    `Last error: ${state.lastErrorMessage ?? 'unknown'}`,
    '',
    'Until this is fixed, work from this and every other session is being dropped, not remembered.',
    'IMPORTANT: Tell the user about this outage at the very start of your first reply, quoting the',
    'error above (it may contain a management URL with the remedy). Suggest checking the observer',
    "provider's API key, spend limits, and base URL in ~/.claude-mem/settings.json.",
  ];
  return lines.join('\n');
}
