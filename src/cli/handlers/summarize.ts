// IO discipline (see src/shared/hook-io.ts): this handler is PURE. It returns a
// HookResult and MUST NOT call process.stderr.write / process.stdout.write /
// console.* / process.exit. logger.* calls are DIAGNOSTIC; thrown errors are
// caught by hookCommand, logged, and answered with a no-op (never exit 2).
import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { executeWithWorkerFallback, isWorkerFallback } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';
import { extractLastAssistantTurn, extractLastAssistantModel } from '../../shared/transcript-parser.js';
import { detectObservedBilling } from '../../shared/observed-billing.js';
import { stripMemoryTags } from '../../utils/tag-stripping.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';
import { shouldTrackProject } from '../../shared/should-track-project.js';
import { clearInjected } from '../../shared/kimi-context-gate.js';
import { resolveRuntimeContext, logServerFallback } from '../../services/hooks/runtime-selector.js';
import type { ServerRuntimeContext } from '../../services/hooks/runtime-selector.js';
import { isServerClientError } from '../../services/hooks/server-client.js';
import { extractAdvisorCalls } from '../../shared/advisor-transcript.js';
import { loadFromFileOnce } from '../../shared/hook-settings.js';

// The ingest route accepts at most this many calls per request.
const ADVISOR_CALLS_PER_REQUEST = 50;

/**
 * Opt-in capture of the turn's `advisor` tool calls
 * (CLAUDE_MEM_CAPTURE_ADVISOR_CALLS). The advisor is a server-side tool
 * (server_tool_use in the transcript), so PostToolUse never fires for it and
 * the Stop hook's scan of the transcript's tail is the only capture point.
 * currentTurnOnly keeps each Stop from re-sending the session's history; the
 * worker's UNIQUE(tool_use_id) absorbs any overlap. Worker runtime only: in
 * server runtime this must not start a local worker (plan-24 step 4), and the
 * server-side store is a follow-up.
 */
async function recordAdvisorCalls(
  sessionId: string,
  transcriptPath: string | undefined,
  cwd: string | undefined,
  platformSource: string,
): Promise<void> {
  if (!transcriptPath) return;
  if (loadFromFileOnce().CLAUDE_MEM_CAPTURE_ADVISOR_CALLS !== 'true') return;
  if (resolveRuntimeContext().runtime === 'server') return;

  const calls = extractAdvisorCalls(transcriptPath, { currentTurnOnly: true });
  if (calls.length === 0) return;

  logger.debug('HOOK', 'Stop: recording advisor calls', { count: calls.length });
  for (let start = 0; start < calls.length; start += ADVISOR_CALLS_PER_REQUEST) {
    await executeWithWorkerFallback<{ status?: string }>('/api/advisor-calls', 'POST', {
      contentSessionId: sessionId,
      platformSource,
      cwd,
      transcriptPath,
      calls: calls.slice(start, start + ADVISOR_CALLS_PER_REQUEST).map(call => ({
        toolUseId: call.toolUseId,
        advice: call.advice,
        advisorModel: call.advisorModel,
        occurredAtEpoch: call.occurredAtEpoch,
        lastUserMessage: call.lastUserMessage,
        transcriptByteOffset: call.transcriptByteOffset,
      })),
    });
  }
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

    // Only the Codex adapter maps stop_hook_active; claude-code.ts explains why
    // Claude Code's flag must never suppress a summary.
    if (input.stopHookActive === true) {
      logger.debug('HOOK', 'Skipping summary: Stop hook re-entry detected (stop_hook_active)', {
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

    // Kimi routes BOTH PreCompact and Stop to this handler, and Kimi's Stop
    // fires at the end of EVERY turn — clearing the once-per-session injection
    // marker on Stop would re-inject the full timeline into every prompt.
    // Clear only on PreCompact so the first prompt after a compaction
    // re-injects a fresh timeline (see src/shared/kimi-context-gate.ts).
    if (input.platform === 'kimi' && input.hookEventName === 'PreCompact') {
      clearInjected(sessionId);
    }

    // Advisor capture runs before summarize's own early returns (an empty
    // assistant message must not drop the turn's advisor calls) and is
    // failure-isolated from it.
    try {
      await recordAdvisorCalls(sessionId, transcriptPath, input.cwd, normalizePlatformSource(input.platform));
    } catch (err) {
      logger.warn('HOOK', 'Advisor-call capture failed; continuing with summary', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    let lastAssistantMessage = '';
    // Observed-session model for telemetry (NOT the observer model): the model
    // the user's IDE session is running, read from its transcript.
    let observedModel: string | undefined;

    // Claude Code sends `last_assistant_message: ""` when a session ends
    // mid-tool-call. An empty or whitespace-only value is no message at all,
    // so fall back to the transcript instead of skipping the summary.
    if (input.lastAssistantMessage?.trim()) {
      lastAssistantMessage = stripMemoryTags(input.lastAssistantMessage);
      // The model is telemetry only — a transcript that cannot be read must
      // never cost the summary Claude Code already handed us.
      try {
        observedModel = transcriptPath ? extractLastAssistantModel(transcriptPath) : undefined;
      } catch (err) {
        logger.warn('HOOK', `Stop hook: could not read observed model from transcript for session ${sessionId}: ${err instanceof Error ? err.message : err}`);
      }
    } else {
      if (!transcriptPath) {
        logger.debug('HOOK', `No transcriptPath in Stop hook input for session ${sessionId} - skipping summary`);
        return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
      }

      try {
        // One read of the transcript yields both the text and the model.
        const turn = extractLastAssistantTurn(transcriptPath, true);
        lastAssistantMessage = stripMemoryTags(turn.text);
        observedModel = turn.model;
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

    // Observed-session billing posture for telemetry (NOT the observer
    // provider). `.claude.json` is Claude Code specific, so billing detection
    // is skipped on other platforms.
    const observedBilling = input.platform === 'claude-code' ? detectObservedBilling() : undefined;

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
        observedModel,
        observedBilling,
      },
    );
    if (isWorkerFallback(queueResult)) {
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    logger.debug('HOOK', 'Summary request queued, exiting hook');
    return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
  },
};
