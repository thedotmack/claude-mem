
import type { EventHandler, HookResult } from '../types.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { isWorkerUnavailableError } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';
import { contextHandler } from './context.js';
import { sessionInitHandler } from './session-init.js';
import { hasInjected, markInjected } from '../../shared/kimi-context-gate.js';
import { takeTimelinePending } from '../../shared/codex-compaction-gate.js';
import { observationHandler } from './observation.js';
import { summarizeHandler } from './summarize.js';
import { sessionEndHandler } from './session-end.js';
import { userMessageHandler } from './user-message.js';
import { fileEditHandler } from './file-edit.js';
import { fileContextHandler } from './file-context.js';
import { postCompactHandler } from './post-compact.js';

export type EventType =
  | 'context'
  | 'session-init'
  | 'session-init-context'
  | 'observation'
  | 'summarize'
  | 'session-end'
  | 'user-message'
  | 'file-edit'
  | 'file-context'
  | 'post-compact';

export const sessionInitContextHandler: EventHandler = {
  async execute(input) {
    let sessionInitResult: HookResult | undefined;
    try {
      sessionInitResult = await sessionInitHandler.execute(input);
    } catch (error: unknown) {
      if (isWorkerUnavailableError(error)) {
        throw error;
      }
      logger.warn('HOOK', 'session-init-context: session-init failed, continuing to context', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const semanticContext = sessionInitResult?.hookSpecificOutput?.additionalContext;

    // Kimi fires this composite on EVERY UserPromptSubmit (SessionStart stdout
    // is not appended by Kimi, so injection had to move here). Gate the
    // timeline fetch to once per session; summarizeHandler clears the marker
    // on kimi PreCompact so the first prompt after compaction re-injects.
    // The composite is only wired for kimi, but guard on platform anyway so a
    // future non-kimi wiring is not silently gated.
    if (input.platform === 'kimi' && input.sessionId && hasInjected(input.sessionId)) {
      logger.debug('HOOK', 'session-init-context: timeline already injected this session, skipping context fetch', {
        sessionId: input.sessionId,
      });
      if (!semanticContext) {
        return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
      }
      return {
        continue: true,
        suppressOutput: true,
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: semanticContext,
        },
      };
    }

    const contextResult = await contextHandler.execute(input);

    // Mark only when a non-empty timeline was actually emitted — a worker
    // outage (empty fallback) must not burn the session's one-shot.
    const injectedTimeline = contextResult.hookSpecificOutput?.additionalContext;
    if (input.platform === 'kimi' && input.sessionId && typeof injectedTimeline === 'string' && injectedTimeline.length > 0) {
      markInjected(input.sessionId);
    }

    if (!semanticContext) {
      return contextResult;
    }

    const contextAdditionalContext = contextResult.hookSpecificOutput?.additionalContext;
    const mergedContext = contextAdditionalContext
      ? `${semanticContext}\n\n${contextAdditionalContext}`
      : semanticContext;

    return {
      ...contextResult,
      hookSpecificOutput: {
        ...(contextResult.hookSpecificOutput ?? { hookEventName: 'SessionStart' }),
        additionalContext: mergedContext,
      },
    };
  }
};

// Codex PostToolUse: a thread that compacted and has had no SessionStart since
// (every subagent thread, since Codex sends SessionStart only to the root)
// gets its memory timeline back here, once, as PostToolUse additionalContext.
// The observation is recorded first, so the context fetch can never cost the
// write. See src/shared/codex-compaction-gate.ts.
export const observationWithPendingTimelineHandler: EventHandler = {
  async execute(input) {
    const observationResult = await observationHandler.execute(input);
    if (input.platform !== 'codex' || !takeTimelinePending(input.sessionId, input.agentId)) {
      return observationResult;
    }

    const contextResult = await contextHandler.execute(input);
    // The once-per-session worker-outage notice, if the context hook consumed
    // it. It is passed on even without a timeline, or nobody would see it.
    const outageNotice = contextResult.systemMessage ? { systemMessage: contextResult.systemMessage } : {};
    const timeline = contextResult.hookSpecificOutput?.additionalContext;
    if (!timeline) {
      return { ...observationResult, ...outageNotice };
    }
    logger.debug('HOOK', 'Re-injecting the memory timeline after a Codex compaction', {
      sessionId: input.sessionId,
      agentId: input.agentId,
    });
    return {
      ...observationResult,
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: timeline },
      ...outageNotice,
    };
  }
};

const handlers: Record<EventType, EventHandler> = {
  'context': contextHandler,
  'session-init': sessionInitHandler,
  'session-init-context': sessionInitContextHandler,
  'observation': observationWithPendingTimelineHandler,
  'summarize': summarizeHandler,
  'session-end': sessionEndHandler,
  'user-message': userMessageHandler,
  'file-edit': fileEditHandler,
  'file-context': fileContextHandler,
  'post-compact': postCompactHandler
};

export function getEventHandler(eventType: string): EventHandler {
  const handler = handlers[eventType as EventType];
  if (!handler) {
    logger.warn('HOOK', `Unknown event type: ${eventType}, returning no-op`);
    return {
      async execute() {
        return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
      }
    };
  }
  return handler;
}

export { contextHandler } from './context.js';
export { sessionInitHandler } from './session-init.js';
export { observationHandler } from './observation.js';
export { summarizeHandler } from './summarize.js';
export { sessionEndHandler } from './session-end.js';
export { userMessageHandler } from './user-message.js';
export { fileEditHandler } from './file-edit.js';
export { fileContextHandler } from './file-context.js';
export { postCompactHandler } from './post-compact.js';
