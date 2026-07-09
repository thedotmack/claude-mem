// IO discipline (see src/shared/hook-io.ts): this handler is PURE. It returns a
// HookResult and MUST NOT call process.stderr.write / process.stdout.write /
// console.* / process.exit. logger.* calls are DIAGNOSTIC; thrown errors are
// caught by hookCommand and routed through emitBlockingError.
import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { executeWithWorkerFallback, isWorkerFallback, consumeWorkerOutageHint } from '../../shared/worker-utils.js';
import { withUserHint } from '../../shared/hook-io.js';
import { logger } from '../../utils/logger.js';
import { extractLastMessage } from '../../shared/transcript-parser.js';
import { stripMemoryTagsFromPrompt } from '../../utils/tag-stripping.js';
import { redactSensitive, getRedactionConfig } from '../../utils/redaction.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';
import { shouldTrackProject } from '../../shared/should-track-project.js';
import { resolveRuntimeContext, logServerFallback } from '../../services/hooks/runtime-selector.js';
import type { ServerRuntimeContext } from '../../services/hooks/runtime-selector.js';
import { isServerClientError } from '../../services/hooks/server-client.js';

/**
 * Capture the turn's `advisor` tool calls. The advisor is a server-side tool
 * (server_tool_use in the transcript) — PostToolUse never fires for it, so
 * the Stop hook's transcript scan is the only capture point. currentTurnOnly
 * keeps each Stop from re-sending the whole session's history; the worker's
 * UNIQUE(tool_use_id) and the server's idempotency key absorb any overlap.
 * Failures here must never break summarization — the caller wraps this.
 */
async function dispatchAdvisorCalls(
  sessionId: string,
  transcriptPath: string | undefined,
  cwd: string | undefined,
  platformSource: string,
): Promise<void> {
  if (!transcriptPath) return;

  const calls = extractAdvisorCalls(transcriptPath, { currentTurnOnly: true });
  if (calls.length === 0) return;

  logger.debug('HOOK', 'Stop: dispatching advisor calls', { count: calls.length });

  const runtime = resolveRuntimeContext();
  if (runtime.runtime === 'server') {
    try {
      for (const call of calls) {
        await runtime.client.recordEvent({
          projectId: runtime.projectId,
          contentSessionId: sessionId,
          platformSource,
          sourceType: 'hook',
          eventType: 'tool_use',
          occurredAtEpoch: call.occurredAtEpoch,
          // Advice is already model output — recording it is the point;
          // never spend a generation job re-compressing it.
          generate: false,
          payload: {
            tool_name: 'advisor',
            tool_response: { type: 'advisor_result', text: call.advice },
            toolUseId: call.toolUseId,
            advisorModel: call.advisorModel,
            cwd,
            lastUserMessage: call.lastUserMessage,
            transcriptPath,
            transcriptLineNumber: call.transcriptLineNumber,
            platformSource,
          },
        });
      }
      return;
    } catch (error: unknown) {
      if (isServerClientError(error) && error.isFallbackEligible()) {
        logServerFallback(error.kind, { status: error.status, message: error.message, route: '/v1/events' });
        // fall through to worker fallback
      } else {
        logger.warn('HOOK', 'Server advisor-call dispatch failed (non-recoverable)', {
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    }
  }

  await executeWithWorkerFallback<{ status?: string }>(
    '/api/advisor-calls',
    'POST',
    {
      contentSessionId: sessionId,
      platformSource,
      cwd,
      transcriptPath,
      calls: calls.map(call => ({
        toolUseId: call.toolUseId,
        advice: call.advice,
        advisorModel: call.advisorModel,
        occurredAtEpoch: call.occurredAtEpoch,
        lastUserMessage: call.lastUserMessage,
        transcriptLineNumber: call.transcriptLineNumber,
      })),
    },
  );
}

async function summarizeViaServer(
  runtime: ServerRuntimeContext,
  sessionId: string,
  lastAssistantMessage: string,
  platformSource: string,
): Promise<HookResult> {
  // Resolve the server_session_id idempotently. /v1/sessions/start is
  // idempotent on (projectId, externalSessionId) and returns the
  // existing row when present.
  const startResult = await runtime.client.startSession({
    projectId: runtime.projectId,
    externalSessionId: sessionId,
    contentSessionId: sessionId,
    platformSource,
  });
  const serverSessionId = startResult.session.id;
  // Record the last assistant message as an event before closing the
  // session so it lands in the generation pipeline.
  await runtime.client.recordEvent({
    projectId: runtime.projectId,
    serverSessionId,
    contentSessionId: sessionId,
    platformSource,
    sourceType: 'hook',
    eventType: 'assistant_message',
    occurredAtEpoch: Date.now(),
    payload: {
      last_assistant_message: lastAssistantMessage,
      platformSource,
    },
  });
  await runtime.client.endSession({ sessionId: serverSessionId });
  logger.debug('HOOK', 'Summary request queued via server');
  return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
}

export const summarizeHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    if (input.cwd && !shouldTrackProject(input.cwd)) {
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    if (input.stopHookActive === true) {
      logger.debug('HOOK', 'Skipping summary: Codex Stop hook re-entry detected', {
        sessionId: input.sessionId,
      });
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    if (input.agentId) {
      logger.debug('HOOK', 'Skipping summary: subagent context detected', {
        sessionId: input.sessionId,
        agentId: input.agentId,
        agentType: input.agentType
      });
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    const { sessionId, transcriptPath } = input;

    if (!sessionId) {
      logger.warn('HOOK', 'summarize: No sessionId provided, skipping');
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    // Advisor capture runs before summarize's own early returns (an empty
    // assistant message must not drop the turn's advisor calls) and is
    // failure-isolated from it.
    try {
      await dispatchAdvisorCalls(sessionId, transcriptPath, input.cwd, normalizePlatformSource(input.platform));
    } catch (err) {
      logger.warn('HOOK', 'Advisor-call capture failed; continuing with summary', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    let lastAssistantMessage = '';

    if (input.lastAssistantMessage !== undefined) {
      lastAssistantMessage = stripMemoryTagsFromPrompt(
        redactSensitive(input.lastAssistantMessage, getRedactionConfig()).redacted,
      );
    } else {
      if (!transcriptPath) {
        logger.debug('HOOK', `No transcriptPath in Stop hook input for session ${sessionId} - skipping summary`);
        return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
      }

      try {
        lastAssistantMessage = extractLastMessage(transcriptPath, 'assistant', true);
        lastAssistantMessage = stripMemoryTagsFromPrompt(
          redactSensitive(lastAssistantMessage, getRedactionConfig()).redacted,
        );
      } catch (err) {
        logger.warn('HOOK', `Stop hook: failed to extract last assistant message for session ${sessionId}: ${err instanceof Error ? err.message : err}`);
        return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
      }
    }

    if (!lastAssistantMessage || !lastAssistantMessage.trim()) {
      logger.debug('HOOK', 'No assistant message available - skipping summary', {
        sessionId,
        transcriptPath
      });
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    logger.dataIn('HOOK', 'Stop: Requesting summary', {
      hasLastAssistantMessage: !!lastAssistantMessage
    });

    const platformSource = normalizePlatformSource(input.platform);

    const runtime = resolveRuntimeContext();
    // Phase 1a (cmem-sdk rename): `runtime.runtime` is the canonical `'server'`
    // value. Legacy `'server-beta'` is normalized inside `selectRuntime()`.
    if (runtime.runtime === 'server') {
      try {
        return await summarizeViaServer(runtime, sessionId, lastAssistantMessage, platformSource);
      } catch (error: unknown) {
        if (isServerClientError(error) && error.isFallbackEligible()) {
          logServerFallback(error.kind, {
            status: error.status,
            message: error.message,
            route: '/v1/sessions/end',
          });
          // fall through to worker fallback
        } else {
          logger.error('HOOK', 'Server summarize failed (non-recoverable)', {
            error: error instanceof Error ? error.message : String(error),
          });
          return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
        }
      }
    }

    const queueResult = await executeWithWorkerFallback<{ status?: string }>(
      '/api/sessions/summarize',
      'POST',
      {
        contentSessionId: sessionId,
        last_assistant_message: lastAssistantMessage,
        platformSource,
      },
    );
    if (isWorkerFallback(queueResult)) {
      const hint = consumeWorkerOutageHint(sessionId);
      const base: HookResult = { continue: true, suppressOutput: !hint, exitCode: HOOK_EXIT_CODES.SUCCESS };
      return hint ? withUserHint(base, hint) : base;
    }

    logger.debug('HOOK', 'Summary request queued, exiting hook');
    return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
  },
};
