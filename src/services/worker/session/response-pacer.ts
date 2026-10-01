/**
 * One unanswered observer prompt at a time (#4066).
 *
 * The Claude SDK consumes the observer's prompts as a streaming input and pulls
 * the next one as soon as it has written the previous one to the child — long
 * before the model answers. Unpaced, a large backlog was claimed and pushed into
 * conversationHistory in one burst, so the generation budget tripped on the sum
 * of UNANSWERED prompts, the recycle aborted the in-flight answer, the same
 * oldest batch went back to pending, and the session looped with zero progress.
 *
 * The feed waits on this gate after every prompt it yields, and ClaudeProvider
 * opens it once per finished turn. Waiting happens before the next pull from the
 * message iterator, so nothing is claimed while a prompt is still unanswered.
 */

import type { ActiveSession } from '../../worker-types.js';
import { logger } from '../../../utils/logger.js';

export type PacerWaitOutcome = 'answered' | 'aborted' | 'closed' | 'stalled';

/**
 * Delay before a generation that stalled on an unanswered prompt is restarted.
 * The stall already preserved the claimed batch; without a resume the backlog
 * would wait for the next captured tool call, which may never come.
 */
export const RESPONSE_STALL_RESUME_DELAY_MS = 30_000;

/**
 * Consecutive stall resumes allowed before the observer stops restarting on its
 * own. An answered queued-work turn resets the count, so this only trips when
 * the provider keeps going silent. The next hook event can still start one.
 */
export const MAX_CONSECUTIVE_STALL_RESUMES = 3;

/**
 * Consecutive rate-limit resumes allowed before a session stops resuming on its
 * own and the provider breaker takes over. An answered queued-work turn resets
 * the count, so this only trips when the provider keeps refusing.
 */
export const MAX_CONSECUTIVE_RATE_LIMIT_RESUMES = 3;

/**
 * Count one response-stall exit and decide whether to resume automatically.
 * Returns the attempt number so the caller can log it.
 */
export function planResponseStallResume(session: ActiveSession): { resume: boolean; attempts: number } {
  return planBoundedResume(session, 'consecutiveResponseStalls', MAX_CONSECUTIVE_STALL_RESUMES);
}

/** Count one rate-limit pause that named a Retry-After and decide whether to resume after it. */
export function planRateLimitResume(session: ActiveSession): { resume: boolean; attempts: number } {
  return planBoundedResume(session, 'consecutiveRateLimitResumes', MAX_CONSECUTIVE_RATE_LIMIT_RESUMES);
}

/**
 * Unattended resumes allowed in a row while memory is on the cmem.ai gateway,
 * whichever pause scheduled them: a transport pause's backoff (#4204), a rate
 * limit's Retry-After, or the move to the Anthropic plan after a cmem fallback.
 * Each one re-sends buffered work with no user activity behind it, and on the
 * gateway each spends plan tokens, so a gateway or model that keeps failing
 * would otherwise be retried for as long as the worker runs. An answered
 * queued-work turn resets the count; the next captured event still starts a
 * generator, and nothing buffered is dropped.
 */
export const MAX_UNATTENDED_GATEWAY_RESUMES = 3;

/**
 * Count one unattended resume and decide whether it may run. Off the gateway
 * nothing is counted: those resumes keep their own bounds (or backoff).
 */
export function planUnattendedGatewayResume(
  session: ActiveSession,
  source: string,
  memoryOnCmemGateway: boolean,
): { resume: boolean; attempts: number } {
  if (!memoryOnCmemGateway) return { resume: true, attempts: 0 };
  const plan = planBoundedResume(session, 'consecutiveUnattendedGatewayResumes', MAX_UNATTENDED_GATEWAY_RESUMES);
  if (!plan.resume) {
    logger.warn('SESSION', 'Unattended resumes stopped on the cmem gateway; buffered work waits for the next hook', {
      sessionId: session.sessionDbId,
      source,
      attempts: plan.attempts,
      maxUnattendedResumes: MAX_UNATTENDED_GATEWAY_RESUMES,
    });
  }
  return plan;
}

/** Read-only: whether this session's unattended gateway resumes are spent (the periodic sweep honours it). */
export function unattendedGatewayResumesSpent(session: ActiveSession): boolean {
  return (session.consecutiveUnattendedGatewayResumes ?? 0) >= MAX_UNATTENDED_GATEWAY_RESUMES;
}

function planBoundedResume(
  session: ActiveSession,
  counter: 'consecutiveResponseStalls' | 'consecutiveRateLimitResumes' | 'consecutiveUnattendedGatewayResumes',
  maxResumes: number,
): { resume: boolean; attempts: number } {
  const attempts = (session[counter] ?? 0) + 1;
  session[counter] = attempts;
  return { resume: attempts <= maxResumes, attempts };
}

export class ObserverResponsePacer {
  private answeredTurns = 0;
  private closed = false;
  private stalled = false;
  private wake: (() => void) | null = null;
  private rearm: ((graceMs: number) => void) | null = null;
  private suspend: (() => void) | null = null;
  private processing = false;

  /** Snapshot taken BEFORE yielding a prompt; an answer can land before the feed resumes. */
  mark(): number {
    return this.answeredTurns;
  }

  /** A turn finished — whatever its outcome — so the feed may send the next prompt. */
  answer(): void {
    this.answeredTurns += 1;
    this.wake?.();
  }

  /** The SDK stream is over; nothing will ever answer, so release the feed for good. */
  close(): void {
    this.closed = true;
    this.wake?.();
  }

  /**
   * The SDK is still talking — a streamed frame, a status or retry message — so
   * the stall window restarts. `graceMs` extends it by a delay the SDK
   * announced (an api_retry backoff), which is waiting, not silence.
   */
  activity(graceMs = 0): void {
    this.rearm?.(graceMs);
  }

  /** Storage and claim acknowledgement belong to the answer, not SDK silence. */
  processingStarted(): void {
    this.processing = true;
    this.suspend?.();
  }

  /** Start a fresh silence window if the result frame has not arrived yet. */
  processingFinished(): void {
    this.processing = false;
    this.rearm?.(0);
  }

  /**
   * True once a wait stalled out. The stall hands the claimed batch back to
   * pending, so the SDK loop must drop any frame that arrives afterwards: a
   * late answer stored now would be stored again when the batch is re-sent.
   */
  get hasStalled(): boolean {
    return this.stalled;
  }

  /**
   * Resolve once a turn has finished since `since`, the signal aborts, the
   * stream closes, or `stallMs` passes with no answer and no SDK activity.
   */
  waitForAnswer(since: number, signal: AbortSignal, stallMs: number): Promise<PacerWaitOutcome> {
    const settled = (): PacerWaitOutcome | null => {
      if (signal.aborted) return 'aborted';
      if (this.closed) return 'closed';
      if (this.answeredTurns > since) return 'answered';
      return null;
    };
    const immediate = settled();
    if (immediate) return Promise.resolve(immediate);

    return new Promise<PacerWaitOutcome>(resolve => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const arm = (graceMs: number) => {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        if (this.processing) return;
        timer = setTimeout(() => {
          // Fence first, synchronously: from here on the SDK loop ignores frames.
          this.stalled = true;
          logger.debug('SDK', 'Observer response pacer stalled; fencing late frames', { stallMs, graceMs });
          finish('stalled');
        }, stallMs + Math.max(0, graceMs));
        timer.unref?.();
      };
      const finish = (outcome: PacerWaitOutcome) => {
        if (timer !== undefined) clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        this.wake = null;
        this.rearm = null;
        this.suspend = null;
        resolve(outcome);
      };
      const onAbort = () => finish('aborted');
      this.wake = () => {
        const outcome = settled();
        if (outcome) finish(outcome);
      };
      this.rearm = arm;
      this.suspend = () => {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
      };
      signal.addEventListener('abort', onAbort, { once: true });
      arm(0);
    });
  }
}
