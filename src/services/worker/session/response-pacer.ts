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
 * Count one response-stall exit and decide whether to resume automatically.
 * Returns the attempt number so the caller can log it.
 */
export function planResponseStallResume(session: ActiveSession): { resume: boolean; attempts: number } {
  const attempts = (session.consecutiveResponseStalls ?? 0) + 1;
  session.consecutiveResponseStalls = attempts;
  return { resume: attempts <= MAX_CONSECUTIVE_STALL_RESUMES, attempts };
}

export class ObserverResponsePacer {
  private answeredTurns = 0;
  private closed = false;
  private stalled = false;
  private wake: (() => void) | null = null;
  private rearm: ((graceMs: number) => void) | null = null;

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
        resolve(outcome);
      };
      const onAbort = () => finish('aborted');
      this.wake = () => {
        const outcome = settled();
        if (outcome) finish(outcome);
      };
      this.rearm = arm;
      signal.addEventListener('abort', onAbort, { once: true });
      arm(0);
    });
  }
}
