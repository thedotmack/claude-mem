/**
 * Retry helper driven by ClassifiedProviderError, following the "never pay
 * twice" rule (xAI SDK retry rules): retry a paid request in place only when it
 * is known the work did not happen.
 *
 * | Outcome (PaidSendOutcome)                                    | In place? |
 * |--------------------------------------------------------------|-----------|
 * | refused_before_work: 429 / our own pre-send refusals         | yes — Retry-After capped at 60s; none ⇒ 1s→30s backoff, jitter ×(0.5–1) |
 * | ambiguous: network error before any response, 5xx, deadline  | no — thrown; the session's transport pause decides, against the batch budget |
 * | output_failure: body read/parse failed, 200 with an error    | never |
 * | rejected (auth, quota, bad request) and unclassified errors  | no |
 *
 * One carve-out for streamed requests (`retryBeforeOutput`, xAI SDK): a
 * transport failure before the model produced any output may be resent once,
 * and only while the batch's PaidSendBudget has a send left.
 *
 * Every send that may have been billed is counted against the claimed batch's
 * PaidSendBudget when one is passed; a spent budget refuses to send at all.
 */

import {
  ClassifiedProviderError,
  DEADLINE_EXCEEDED_CODE,
  PAID_SEND_BUDGET_EXHAUSTED_CODE,
  isClassified,
  paidSendOutcomeOf,
} from './provider-errors.js';
import type { PaidSendBudget } from './paid-send-budget.js';
import { logger } from '../../utils/logger.js';
import { DEFAULT_LLM_TIMEOUT_MS, SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { FIELD_OPTIMIZE_TIMEOUT_MS } from './field-optimizer.js';

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
  /** Maximum in-place retries of a refused-before-work send (in addition to the initial attempt). Default 2. */
  maxRetries?: number;
  /** Per-attempt timeout in ms. Default: CLAUDE_MEM_LLM_TIMEOUT_MS (resolveLlmTimeoutMs). */
  perAttemptTimeoutMs?: number;
  /** Base delay used for exponential backoff when no Retry-After was sent. Default 1s. */
  baseDelayMs?: number;
  /** Cap for backoff delay. Default 30s. */
  maxDelayMs?: number;
  /** Tag for logging. */
  label?: string;
  /** External abort signal. */
  abortSignal?: AbortSignal;
  /**
   * Classified kinds this call must NOT retry, even when `isRetryableKind`
   * would.
   *
   * Exists for multi-key rotation. `rate_limit` is retryable against one key —
   * waiting out a per-minute window is the right move when that key is all
   * there is. With a pool it is the wrong move: the caller has another key that
   * is not rate limited, and honoring `retryAfterMs` twice first spends the
   * window it was trying to avoid. The pool wrapper passes the rotate-worthy
   * kinds here so they reach it after the first failed request, while
   * `transient` keeps retrying in place.
   */
  nonRetryableKinds?: readonly string[];
  /**
   * The claimed batch's paid-send allowance, shared with the session's
   * transport and stall resumes. Each send that may have been billed spends
   * one; none left, withRetry refuses to send.
   */
  paidSendBudget?: PaidSendBudget;
  /** The `x-client-request-id` the caller sends; stamped on classified errors for logs. */
  clientAttemptId?: string;
  /**
   * The caller bounds each attempt itself (an idle timeout on a streamed reply
   * plus an absolute cap), so withRetry arms no per-attempt deadline. A live
   * stream is never abandoned for taking long.
   */
  attemptDeadlineOwnedByCaller?: boolean;
  /**
   * Resend once a streamed request whose transport failed before any output
   * (ClassifiedProviderError.failedBeforeOutput), if the PaidSendBudget has a
   * send left. Still bounded by maxRetries.
   */
  retryBeforeOutput?: boolean;
}

/** A Retry-After longer than this is not waited out in place. */
export const MAX_RETRY_AFTER_MS = 60_000;

/** Bounds shared with the other CLAUDE_MEM_*_TIMEOUT_MS settings. */
export const MAX_LLM_TIMEOUT_MS = 300_000;
const LLM_TIMEOUT_BOUNDS = { min: 500, max: MAX_LLM_TIMEOUT_MS } as const;

/**
 * Bounds-check one CLAUDE_MEM_*_TIMEOUT_MS value (env or settings.json).
 *
 * Complete integer only. parseInt('90000ms') would silently accept a typo
 * as 90000 — Greptile reproduced that on #3808. settings.json values come
 * back as parsed JSON, so a bare number (90000) arrives as a number, not a
 * string. Only a string or a number is accepted: String([90000]) would read
 * as "90000". A falsy value (unset, empty) falls back without a warning.
 *
 * `fallbackMs` is the caller's own default, so each resolver keeps its default
 * where the value lives instead of every caller inheriting one constant.
 */
function parseTimeoutMs(raw: unknown, keyName: string, fallbackMs: number): number {
  if (!raw) return fallbackMs;
  const trimmed = typeof raw === 'string' || typeof raw === 'number' ? String(raw).trim() : '';
  const parsed = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (
    Number.isFinite(parsed)
    && parsed >= LLM_TIMEOUT_BOUNDS.min
    && parsed <= LLM_TIMEOUT_BOUNDS.max
  ) {
    return parsed;
  }
  logger.warn('SDK', `Invalid ${keyName}, using default`, {
    value: raw,
    min: LLM_TIMEOUT_BOUNDS.min,
    max: LLM_TIMEOUT_BOUNDS.max,
  });
  return fallbackMs;
}

/**
 * Per-attempt deadline for a provider request.
 *
 * The deadline catches a hung request; it must sit above normal latency, or it
 * abandons work the backend already computed — and, on a metered backend, work
 * that can still be billed. The old 30s did exactly that twice over: an Ollama
 * backend measured a p99 of 29.8s (#3794), and the cmem.ai gateway runs p90
 * 40–72s, p99 ~100–140s, so ~20% of its served requests were cut off. The
 * default (DEFAULT_LLM_TIMEOUT_MS) now clears that tail; see its note.
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
  return parseTimeoutMs(raw, 'CLAUDE_MEM_LLM_TIMEOUT_MS', DEFAULT_LLM_TIMEOUT_MS);
}

/**
 * The remedy an expired deadline carries, naming the place the deadline is
 * actually read from. Whenever the env var is set, resolveLlmTimeoutMs never
 * reads settings.json (an unusable value falls back to the default, not to the
 * file), so advising a settings.json edit then would change nothing.
 */
function llmTimeoutRemedy(): string {
  return process.env.CLAUDE_MEM_LLM_TIMEOUT_MS === undefined
    ? `Raise CLAUDE_MEM_LLM_TIMEOUT_MS in ~/.claude-mem/settings.json (up to ${LLM_TIMEOUT_BOUNDS.max}) if the backend is simply slow.`
    : `Raise CLAUDE_MEM_LLM_TIMEOUT_MS (up to ${LLM_TIMEOUT_BOUNDS.max}) if the backend is simply slow. `
      + 'It is set in your environment, which overrides ~/.claude-mem/settings.json, so change it there.';
}

/**
 * Deadline for one oversized-field condensation pass (field-optimizer.ts).
 *
 * The field pass races a bounded model call against this deadline; on expiry
 * the observation falls back to head/tail truncation, so a backend slower than
 * the deadline silently loses field detail. The default is the observer
 * request's (FIELD_OPTIMIZE_TIMEOUT_MS; see there for why).
 * Resolved with the same env-first, then settings.json, per-call rules as
 * resolveLlmTimeoutMs and sharing the same bounds, so it is reachable from
 * configuration instead of being frozen in the shipped bundle.
 */
export function resolveFieldOptimizeTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
  settingsPath: string = USER_SETTINGS_PATH,
): number {
  const raw = env.CLAUDE_MEM_FIELD_OPTIMIZE_TIMEOUT_MS
    ?? SettingsDefaultsManager.loadFromFile(settingsPath, false).CLAUDE_MEM_FIELD_OPTIMIZE_TIMEOUT_MS;
  return parseTimeoutMs(raw, 'CLAUDE_MEM_FIELD_OPTIMIZE_TIMEOUT_MS', FIELD_OPTIMIZE_TIMEOUT_MS);
}

const DEFAULT_OPTIONS: Required<Pick<RetryOptions, 'maxRetries' | 'baseDelayMs' | 'maxDelayMs'>> = {
  maxRetries: 2,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
};

/**
 * Returns true only when a failed send may be retried in place: the backend
 * refused it before doing any work. Ambiguous, output-failure, rejected and
 * unclassified errors are never retried here.
 */
export function isRetryableKind(err: unknown, nonRetryableKinds?: readonly string[]): boolean {
  if (isClassified(err) && nonRetryableKinds?.includes(err.kind)) return false;
  return paidSendOutcomeOf(err) === 'refused_before_work';
}

/**
 * A streamed send that failed before any output may be resent once (see the
 * carve-out at the top of this file): only when the caller opted in, not yet
 * used, the caller has not aborted, and the batch budget has a send left. With
 * no budget (an init turn, a wrap-up) the single resend is still the limit.
 */
function isRetryableBeforeOutput(err: unknown, options: RetryOptions, alreadyRetriedBeforeOutput: boolean): boolean {
  if (!options.retryBeforeOutput || alreadyRetriedBeforeOutput) return false;
  if (options.abortSignal?.aborted) return false;
  if (!isClassified(err) || err.failedBeforeOutput !== true) return false;
  if (paidSendOutcomeOf(err) !== 'ambiguous') return false;
  return options.paidSendBudget ? options.paidSendBudget.hasRemainingPaidSend() : true;
}

/** Exponential backoff: baseDelayMs * 2^attempt, capped at maxDelayMs, times a jitter in [0.5, 1). */
export function computeBackoffMs(attempt: number, opts: { baseDelayMs: number; maxDelayMs: number }): number {
  const exponential = Math.min(opts.baseDelayMs * Math.pow(2, attempt), opts.maxDelayMs);
  return Math.floor(exponential * (0.5 + Math.random() * 0.5));
}

/**
 * Run `fn` with retry. `fn` receives an AbortSignal scoped to the current
 * attempt's timeout. The outcome of a failed send (paidSendOutcomeOf) drives
 * the retry/no-retry decision; see the table at the top of this file.
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

  const budget = options.paidSendBudget;
  const clientAttemptId = options.clientAttemptId ?? budget?.clientAttemptId;
  let retriedBeforeOutput = false;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    if (options.abortSignal?.aborted) {
      throw new Error('Aborted');
    }
    if (budget && !budget.hasRemainingPaidSend()) {
      throw new ClassifiedProviderError(
        `${opts.label ?? 'Request'} not sent: this batch already made ${budget.spentPaidSends} paid sends`,
        {
          kind: 'transient',
          code: PAID_SEND_BUDGET_EXHAUSTED_CODE,
          paidSendOutcome: 'rejected',
          cause: null,
          ...(clientAttemptId ? { clientAttemptId } : {}),
        },
      );
    }

    // Per-attempt timeout via AbortController. Forward external aborts too.
    const attemptController = new AbortController();
    let deadlineExpired = false;
    const timeoutHandle = options.attemptDeadlineOwnedByCaller ? undefined : setTimeout(() => {
      deadlineExpired = true;
      attemptController.abort();
    }, opts.perAttemptTimeoutMs);
    const onExternalAbort = () => attemptController.abort();
    options.abortSignal?.addEventListener('abort', onExternalAbort, { once: true });

    try {
      const result = await fn(attemptController.signal);
      budget?.recordPaidSend();
      return result;
    } catch (err: unknown) {
      lastError = err;
      if (isClassified(err) && clientAttemptId && !err.clientAttemptId) {
        err.clientAttemptId = clientAttemptId;
      }

      // Our own deadline, not a network blip. Retrying it in-loop against a
      // backend that is already saturated is what turns a latency problem into
      // a congestion collapse, so it throws immediately. It is still a
      // transient condition: classified as such, the session preserves its
      // buffered work for the next generator instead of finalizing with
      // reason=null and dropping it. The code keeps it apart from a network
      // fault — we abandoned a request the backend may still bill — and the
      // action is the remedy the session-start warning shows for it.
      if (deadlineExpired) {
        budget?.recordPaidSend();
        throw new ClassifiedProviderError(
          `${opts.label ?? 'Request'} exceeded the ${opts.perAttemptTimeoutMs}ms per-attempt deadline.`,
          {
            kind: 'transient',
            code: DEADLINE_EXCEEDED_CODE,
            paidSendOutcome: 'ambiguous',
            action: llmTimeoutRemedy(),
            cause: err,
            ...(clientAttemptId ? { clientAttemptId } : {}),
          },
        );
      }

      const outcome = paidSendOutcomeOf(err);
      if (outcome !== 'refused_before_work' && outcome !== 'rejected') {
        budget?.recordPaidSend();
      }

      // The caller cancelled mid-flight: report it the way the pre-send and
      // backoff checks do, keeping the runtime's own abort error as the cause.
      if (options.abortSignal?.aborted && !isClassified(err)) {
        throw new Error('Aborted', { cause: err });
      }

      const retryableInPlace = isRetryableKind(err, options.nonRetryableKinds);
      const resendBeforeOutput = !retryableInPlace && isRetryableBeforeOutput(err, options, retriedBeforeOutput);
      if (!retryableInPlace && !resendBeforeOutput) {
        throw err;
      }

      if (attempt === opts.maxRetries) {
        throw err;
      }
      if (resendBeforeOutput) retriedBeforeOutput = true;

      // Honor the backend's Retry-After, capped; otherwise exponential backoff.
      const delayMs = isClassified(err) && err.retryAfterMs !== undefined
        ? Math.min(Math.max(err.retryAfterMs, 0), MAX_RETRY_AFTER_MS)
        : computeBackoffMs(attempt, { baseDelayMs: opts.baseDelayMs, maxDelayMs: opts.maxDelayMs });

      const errMsg = err instanceof Error ? err.message : String(err);
      logger.warn('SDK', `Retrying ${opts.label ?? 'fetch'} after ${delayMs}ms (attempt ${attempt + 1}/${opts.maxRetries})`, {
        kind: isClassified(err) ? err.kind : 'unclassified',
        outcome,
        ...(clientAttemptId ? { clientAttemptId } : {}),
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
