/**
 * Session Init Handler - UserPromptSubmit
 *
 * Extracted from new-hook.ts - initializes session and starts SDK agent.
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { executeWithWorkerFallback, isWorkerFallback } from '../../shared/worker-utils.js';
import { getProjectContext } from '../../utils/project-name.js';
import { logger } from '../../utils/logger.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { shouldTrackProject } from '../../shared/should-track-project.js';
import { loadFromFileOnce } from '../../shared/hook-settings.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';
import { isInternalProtocolPayload } from '../../utils/tag-stripping.js';

interface SessionInitResponse {
  sessionDbId: number;
  promptNumber: number;
  skipped?: boolean;
  reason?: string;
  contextInjected?: boolean;
}

interface SemanticContextResponse {
  context: string;
  count: number;
}

export const sessionInitHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const { sessionId, prompt: rawPrompt } = input;
    const cwd = input.cwd ?? process.cwd();  // Match context.ts fallback (#1918)

    // Guard: Codex CLI and other platforms may not provide a session_id (#744)
    if (!sessionId) {
      logger.warn('HOOK', 'session-init: No sessionId provided, skipping (Codex CLI or unknown platform)');
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    // Plan 05 Phase 5: project exclusion via single helper.
    if (!shouldTrackProject(cwd)) {
      logger.info('HOOK', 'Project excluded from tracking', { cwd });
      return { continue: true, suppressOutput: true };
    }

    // Handle image-only prompts (where text prompt is empty/undefined)
    // Use placeholder so sessions still get created and tracked for memory
    const prompt = (!rawPrompt || !rawPrompt.trim()) ? '[media prompt]' : rawPrompt;

    if (isInternalProtocolPayload(prompt)) {
      logger.debug('HOOK', 'session-init: skipping internal protocol payload', {
        preview: prompt.slice(0, 80),
      });
      return { continue: true, suppressOutput: true };
    }

    const project = getProjectContext(cwd).primary;
    const platformSource = normalizePlatformSource(input.platform);

    logger.debug('HOOK', 'session-init: Calling /api/sessions/init', { contentSessionId: sessionId, project });

    // Plan 05 Phase 2: single helper for ensure-worker-alive → request → fallback.
    const initResult = await executeWithWorkerFallback<SessionInitResponse>(
      '/api/sessions/init',
      'POST',
      {
        contentSessionId: sessionId,
        project,
        prompt,
        platformSource,
      },
    );

    if (isWorkerFallback(initResult)) {
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    // Worker may have returned a non-2xx body (parsed but missing fields). Fail-soft.
    if (typeof initResult?.sessionDbId !== 'number') {
      logger.failure('HOOK', 'Session initialization returned malformed response', { contentSessionId: sessionId, project });
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    const sessionDbId = initResult.sessionDbId;
    const promptNumber = initResult.promptNumber;

    logger.debug('HOOK', 'session-init: Received from /api/sessions/init', { sessionDbId, promptNumber, skipped: initResult.skipped, contextInjected: initResult.contextInjected });

    // Debug-level alignment log for detailed tracing
    logger.debug('HOOK', `[ALIGNMENT] Hook Entry | contentSessionId=${sessionId} | prompt#=${promptNumber} | sessionDbId=${sessionDbId}`);

    // Check if prompt was entirely private (worker performs privacy check)
    if (initResult.skipped && initResult.reason === 'private') {
      logger.info('HOOK', `INIT_COMPLETE | sessionDbId=${sessionDbId} | promptNumber=${promptNumber} | skipped=true | reason=private`, {
        sessionId: sessionDbId
      });
      return { continue: true, suppressOutput: true };
    }

    // Plan 05 Phase 7: agent init is idempotent — call unconditionally for
    // every Claude Code session. Cursor still skipped (no SDK agent).
    if (input.platform !== 'cursor' && sessionDbId) {
      // Strip leading slash from commands for memory agent
      // /review 101 -> review 101 (more semantic for observations)
      const cleanedPrompt = prompt.startsWith('/') ? prompt.substring(1) : prompt;

      logger.debug('HOOK', 'session-init: Calling /sessions/{sessionDbId}/init', { sessionDbId, promptNumber });

      const agentInitResult = await executeWithWorkerFallback<{ status?: string }>(
        `/sessions/${sessionDbId}/init`,
        'POST',
        { userPrompt: cleanedPrompt, promptNumber },
      );
      if (isWorkerFallback(agentInitResult)) {
        // Worker became unreachable mid-invocation; fail-loud counter handled it.
        return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
      }
    } else if (input.platform === 'cursor') {
      logger.debug('HOOK', 'session-init: Skipping SDK agent init for Cursor platform', { sessionDbId, promptNumber });
    }

    // Semantic context injection: query Chroma for relevant past observations
    // and inject as additionalContext so Claude receives relevant memory each prompt.
    // Controlled by CLAUDE_MEM_SEMANTIC_INJECT setting (default: true).
    // Plan 05 Phase 4: settings via process-scope cache.
    const settings = loadFromFileOnce();
    const semanticInject =
      String(settings.CLAUDE_MEM_SEMANTIC_INJECT).toLowerCase() === 'true';
    let additionalContext = '';

    if (semanticInject && prompt && prompt.length >= 20 && prompt !== '[media prompt]') {
      const limit = settings.CLAUDE_MEM_SEMANTIC_INJECT_LIMIT || '5';
      const semanticResult = await executeWithWorkerFallback<SemanticContextResponse>(
        '/api/context/semantic',
        'POST',
        { q: prompt, project, limit },
      );
      if (!isWorkerFallback(semanticResult) && semanticResult?.context) {
        logger.debug('HOOK', `Semantic injection: ${semanticResult.count} observations for prompt`, { sessionId: sessionDbId, count: semanticResult.count });
        additionalContext = semanticResult.context;
      }
    }

    logger.info('HOOK', `INIT_COMPLETE | sessionDbId=${sessionDbId} | promptNumber=${promptNumber} | project=${project}`, {
      sessionId: sessionDbId
    });

    // Return with semantic context if available
    if (additionalContext) {
      return {
        continue: true,
        suppressOutput: true,
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext
        }
      };
    }

    return { continue: true, suppressOutput: true };
  }
};
