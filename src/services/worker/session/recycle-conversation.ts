/**
 * Retire a full observer conversation and start a fresh generation (#3800).
 *
 * Two paths reach here:
 *  - proactive: the generation has spent its character budget, checked BEFORE
 *    a send, so the request that would cross the ceiling is never paid for;
 *  - reactive: the provider refused a request as too long, which is the safety
 *    net for models whose window is narrower than the budget assumes.
 *
 * Both do the same thing, because the conversation is not the memory. The
 * claimed batch goes back to pending, the outgrown conversation is dropped, and
 * the next captured tool call opens a fresh generation seeded with the
 * session's own observations. No turn is "trimmed" and no gap is invented:
 * continuity rides on the observations claude-mem has already written.
 */

import type { ActiveSession } from '../../worker-types.js';
import type { SessionManager } from '../SessionManager.js';
import type { WorkerRef } from '../agents/types.js';
import { generateContext } from '../../context-generator.js';
import { logger } from '../../../utils/logger.js';

/**
 * The session-start context for a generation that begins partway through a
 * session.
 *
 * This is the SAME builder the SessionStart hook uses to brief a brand-new
 * Claude Code session on what came before it. A recycled observer generation is
 * in exactly that position, so it is briefed exactly that way — rather than by
 * a second, parallel rendering of the same rows.
 *
 * Keying on project + cwd (not on the SDK session id) is deliberate: the id is
 * reset on every generator start, so anything keyed to it reads empty by the
 * time a generation is actually built.
 *
 * Used on every generator start, not just after a recycle: a generator also
 * starts fresh after a quota or auth pause, and in each case the observer
 * should know what it already captured rather than re-recording it.
 */
export async function loadSessionStartContext(
  session: ActiveSession,
  cwd?: string,
): Promise<string> {
  try {
    const context = await generateContext({
      cwd: cwd ?? process.cwd(),
      projects: [session.project],
      platformSource: session.platformSource,
      source: 'compact',
    });
    logger.info('SESSION', 'Briefed the observer generation with session-start context', {
      sessionId: session.sessionDbId,
      project: session.project,
      contextChars: context.length,
    });
    return context;
  } catch (error) {
    // Briefing is an optimization; a fresh generation is still correct without
    // it. Never let this stop the observer from starting.
    logger.warn('SESSION', 'Could not build session-start context for the observer generation', {
      sessionId: session.sessionDbId,
    }, error instanceof Error ? error : new Error(String(error)));
    return '';
  }
}

/**
 * Consecutive recycles allowed before the observer stops trying.
 *
 * A fresh generation carries only the framing prompt, the session-so-far block
 * and one field-truncated observation, so it fits by construction. Needing
 * several in a row means something else is oversized, and continuing would
 * re-send an over-ceiling prompt on every future tool call.
 */
export const MAX_CONSECUTIVE_RECYCLES = 2;

/**
 * How long to withhold observer restarts after recycling failed to produce a
 * conversation that fits. Mirrors the quota breaker: without a gate the next
 * captured tool call simply spawns another generator that aborts on the same
 * budget check.
 */
export const OVERFLOW_EXHAUSTED_COOLDOWN_MS = 10 * 60_000;

export interface RecycleOutcome {
  /** False when the recycle budget is spent and the observer paused instead. */
  recycled: boolean;
  /** Consecutive recycle count after this attempt. */
  attempts: number;
}

export async function recycleObserverConversation(
  session: ActiveSession,
  sessionManager: SessionManager,
  worker: WorkerRef | undefined,
  trigger: 'budget' | 'refused',
  detail: string,
): Promise<RecycleOutcome> {
  const attempts = (session.consecutiveContextOverflows ?? 0) + 1;
  session.consecutiveContextOverflows = attempts;

  // The observations are fine; the conversation carrying them is what filled up.
  await sessionManager.resetProcessingToPending(session.sessionDbId);

  if (attempts > MAX_CONSECUTIVE_RECYCLES) {
    // Drop the conversation here too. Leaving it in place meant the next start
    // re-sent an over-ceiling prompt and grew it further — one spawn, one
    // refusal and one abort per captured tool call, unbounded.
    session.conversationHistory = [];
    session.forceInit = true;
    // Withhold restarts for a cooldown instead of letting the next ingest spawn
    // a generator that can only abort again.
    session.overflowPausedUntilMs = Date.now() + OVERFLOW_EXHAUSTED_COOLDOWN_MS;
    session.abortReason = 'overflow:exhausted';
    abort(session);
    worker?.broadcastProcessingStatus?.();
    logger.error('SESSION', `Observer conversation still does not fit after ${MAX_CONSECUTIVE_RECYCLES} recycles — pausing this session's observer instead of retrying`, {
      sessionId: session.sessionDbId,
      trigger,
      detail,
      consecutiveRecycles: attempts,
    });
    return { recycled: false, attempts };
  }

  const discardedMessages = session.conversationHistory.length;
  session.conversationHistory = [];
  session.forceInit = true;
  session.abortReason = 'overflow:recycle';
  abort(session);
  worker?.broadcastProcessingStatus?.();

  logger.info('SESSION', 'Retiring the observer conversation and starting a fresh generation', {
    sessionId: session.sessionDbId,
    trigger,
    detail,
    discardedMessages,
    consecutiveRecycles: attempts,
  });

  return { recycled: true, attempts };
}

function abort(session: ActiveSession): void {
  try {
    session.abortController.abort();
  } catch {
    // best-effort; AbortController.abort() should not throw in normal use.
  }
}
