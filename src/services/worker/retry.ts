/**
 * Retry helper that consumes ClassifiedProviderError.kind to decide whether to
 * retry. Pattern adapted from open-agent-sdk's retry.ts (MIT) — exponential
 * backoff with jitter, but driven by classified error kinds, not raw HTTP
 * status codes.
 *
 * Used by GeminiProvider + OpenRouterProvider for fetch retries. Cap retries
 * at 2 because POSTs to these APIs aren't strictly idempotent; we honor a
 * provider-supplied request-id (best-effort) for dedup.
 */

import { ClassifiedProviderError, isClassified } from './provider-errors.js';
import { logger } from '../../utils/logger.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';

/**
 * Parse Retry-After header (seconds or HTTP-date).
 * Returns ms or undefined.
 */
export function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (!Number.isNaN(seconds) && seconds >= 0) {
    return Math.floor(seconds * 1000);
  }
  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) {
    const delta = dateMs - Date.now();
    return delta > 0 ? delta : 0;
  }
  return undefined;
}

export interface RetryOptions {
  /** Maximum retry attempts (in addition to the initial attempt). Cap=2 by default for non-idempotent POSTs. */
  maxRetries?: number;
  /** Per-attempt timeout in ms. Default 30s. */
  perAttemptTimeoutMs?: number;
  /** Base delay used for exponential backoff. Default 100ms. */
  baseDelayMs?: number;
  /** Cap for backoff delay. Default 30s. */
  maxDelayMs?: number;
  /** Tag for logging. */
  label?: string;
  /** External abort signal. */
  abortSignal?: AbortSignal;
}

/** Bounds shared with the other CLAUDE_MEM_*_TIMEOUT_MS settings. */
const LLM_TIMEOUT_BOUNDS = { min: 500, max: 300_000 } as const;
const FALLBACK_PER_ATTEMPT_TIMEOUT_MS = 30_000;

/**
 * Per-attempt deadline for a provider request.
 *
 * 30s suits a hosted provider and is far too short for a local model: a
 * report on an Ollama backend measured successful requests with a median of
 * 21s and a p99 of 29.8s, so the deadline was truncating work that had
 * already been computed. The value was unreachable from configuration, and
 * the workaround was editing the installed bundle after every update.
 *
 * Resolved like every other CLAUDE_MEM_* setting — env override first, then
 * ~/.claude-mem/settings.json — and on every call, so a settings change takes
 * effect without a restart. Read here rather than through worker-utils'
 * readTimeoutEnv, which pulls in the supervisor and telemetry.
 */
export function resolveLlmTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
  settingsPath: string = USER_SETTINGS_PATH,
): number {
  const raw = env.CLAUDE_MEM_LLM_TIMEOUT_MS
    ?? SettingsDefaultsManager.loadFromFile(settingsPath, false).CLAUDE_MEM_LLM_TIMEOUT_MS;
  if (!raw) return FALLBACK_PER_ATTEMPT_TIMEOUT_MS;
  // Complete integer only. parseInt('90000ms') would silently accept a typo
  // as 90000 — Greptile reproduced that on #3808. settings.json values come
  // back as parsed JSON, so a bare number (90000) arrives as a number, not a string.
  // Only a string or a number is accepted: String([90000]) would read as "90000".
  const trimmed = typeof raw === 'string' || typeof raw === 'number' ? String(raw).trim() : '';
  const parsed = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (
    Number.isFinite(parsed)
    && parsed >= LLM_TIMEOUT_BOUNDS.min
    && parsed <= LLM_TIMEOUT_BOUNDS.max
  ) {
    return parsed;
  }
  logger.warn('SDK', 'Invalid CLAUDE_MEM_LLM_TIMEOUT_MS, using default', {
    value: raw,
    min: LLM_TIMEOUT_BOUNDS.min,
    max: LLM_TIMEOUT_BOUNDS.max,
  });
  return FALLBACK_PER_ATTEMPT_TIMEOUT_MS;
}

const DEFAULT_OPTIONS: Required<Omit<RetryOptions, 'label' | 'abortSignal' | 'perAttemptTimeoutMs'>> = {
  maxRetries: 2,
  baseDelayMs: 100,
  maxDelayMs: 30_000,
};

/** Returns true if a classified error is worth retrying. */
export function isRetryableKind(err: unknown): boolean {
  if (!isClassified(err)) {
    // Unclassified errors are treated as transient (preserve old default).
    return true;
  }
  return err.kind === 'transient' || err.kind === 'rate_limit';
}

/** Compute backoff delay: 100 * 2^attempt + random(50). Capped at maxDelayMs. */
export function computeBackoffMs(attempt: number, opts: { baseDelayMs: number; maxDelayMs: number }): number {
  const exponential = opts.baseDelayMs * Math.pow(2, attempt);
  const jitter = Math.random() * 50;
  return Math.min(exponential + jitter, opts.maxDelayMs);
}

/**
 * Run `fn` with retry. `fn` receives an AbortSignal scoped to the current
 * attempt's timeout. The classified error from `fn` (if any) drives the
 * retry/no-retry decision. Honors `retryAfterMs` for rate_limit kind.
 */
export async function withRetry<T>(
  fn: (attemptSignal: AbortSignal) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const opts = {
    ...DEFAULT_OPTIONS,
    ...options,
    perAttemptTimeoutMs: options.perAttemptTimeoutMs ?? resolveLlmTimeoutMs(),
  };
  let lastError: unknown;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    if (options.abortSignal?.aborted) {
      throw new Error('Aborted');
    }

    // Per-attempt timeout via AbortController. Forward external aborts too.
    const attemptController = new AbortController();
    let deadlineExpired = false;
    const timeoutHandle = setTimeout(() => {
      deadlineExpired = true;
      attemptController.abort();
    }, opts.perAttemptTimeoutMs);
    const onExternalAbort = () => attemptController.abort();
    options.abortSignal?.addEventListener('abort', onExternalAbort, { once: true });

    try {
      return await fn(attemptController.signal);
    } catch (err: unknown) {
      lastError = err;

      // Our own deadline, not a network blip. Retrying it in-loop against a
      // backend that is already saturated is what turns a latency problem into
      // a congestion collapse, so it throws immediately. It is still a
      // transient condition: classified as such, the session preserves its
      // buffered work for the next generator instead of finalizing with
      // reason=null and dropping it.
      if (deadlineExpired) {
        throw new ClassifiedProviderError(
          `${opts.label ?? 'Request'} exceeded the ${opts.perAttemptTimeoutMs}ms per-attempt deadline. `
          + 'Raise CLAUDE_MEM_LLM_TIMEOUT_MS if the backend is simply slow.',
          { kind: 'transient', cause: err },
        );
      }

      if (!isRetryableKind(err)) {
        throw err;
      }

      if (attempt === opts.maxRetries) {
        throw err;
      }

      // Honor retryAfterMs from rate_limit errors; otherwise exponential backoff.
      let delayMs: number;
      if (isClassified(err) && err.kind === 'rate_limit' && err.retryAfterMs !== undefined) {
        delayMs = err.retryAfterMs;
      } else {
        delayMs = computeBackoffMs(attempt, { baseDelayMs: opts.baseDelayMs, maxDelayMs: opts.maxDelayMs });
      }

      const errMsg = err instanceof Error ? err.message : String(err);
      logger.warn('SDK', `Retrying ${opts.label ?? 'fetch'} after ${delayMs}ms (attempt ${attempt + 1}/${opts.maxRetries})`, {
        kind: isClassified(err) ? err.kind : 'unclassified',
        message: errMsg.substring(0, 200),
      });
      // Abort-aware sleep: an external abort during backoff should exit
      // immediately instead of waiting out the full delay.
      await new Promise<void>((resolve, reject) => {
        const signal = options.abortSignal;
        if (signal?.aborted) {
          reject(new Error('Aborted'));
          return;
        }
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        }, delayMs);
        const onAbort = () => {
          clearTimeout(timer);
          reject(new Error('Aborted'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    } finally {
      clearTimeout(timeoutHandle);
      options.abortSignal?.removeEventListener('abort', onExternalAbort);
    }
  }

  // Reachable only if opts.maxRetries < 0 (loop never executed). The success
  // and exhaustion paths both return/throw inside the loop. This guards
  // pathological inputs and satisfies TypeScript's return-type exhaustiveness.
  throw lastError ?? new Error('withRetry exited without an attempt (maxRetries < 0)');
}
