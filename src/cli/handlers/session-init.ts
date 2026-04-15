/**
 * Session Init Handler - UserPromptSubmit
 *
 * Extracted from new-hook.ts - initializes session and starts SDK agent.
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { ensureWorkerRunning, workerHttpRequest } from '../../shared/worker-utils.js';
import { getProjectContext } from '../../utils/project-name.js';
import { logger } from '../../utils/logger.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { isProjectExcluded } from '../../utils/project-filter.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';

export const sessionInitHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    // Ensure worker is running before any other logic
    const workerReady = await ensureWorkerRunning();
    if (!workerReady) {
      // Worker not available - skip session init gracefully
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    const { sessionId, cwd, prompt: rawPrompt } = input;

    // Guard: Codex CLI and other platforms may not provide a session_id (#744)
    if (!sessionId) {
      logger.warn('HOOK', 'session-init: No sessionId provided, skipping (Codex CLI or unknown platform)');
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    // Check if project is excluded from tracking
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    if (cwd && isProjectExcluded(cwd, settings.CLAUDE_MEM_EXCLUDED_PROJECTS)) {
      logger.info('HOOK', 'Project excluded from tracking', { cwd });
      return { continue: true, suppressOutput: true };
    }

    // Handle image-only prompts (where text prompt is empty/undefined)
    // Use placeholder so sessions still get created and tracked for memory
    const prompt = (!rawPrompt || !rawPrompt.trim()) ? '[media prompt]' : rawPrompt;

    const project = getProjectContext(cwd).primary;
    const platformSource = normalizePlatformSource(input.platform);

    logger.debug('HOOK', 'session-init: Calling /api/sessions/init', { contentSessionId: sessionId, project });

    // Initialize session via HTTP - handles DB operations and privacy checks
    const initResponse = await workerHttpRequest('/api/sessions/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contentSessionId: sessionId,
        project,
        prompt,
        platformSource
      })
    });

    if (!initResponse.ok) {
      // Log but don't throw - a worker 500 should not block the user's prompt
      logger.failure('HOOK', `Session initialization failed: ${initResponse.status}`, { contentSessionId: sessionId, project });
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    const initResult = await initResponse.json() as {
      sessionDbId: number;
      promptNumber: number;
      skipped?: boolean;
      reason?: string;
      contextInjected?: boolean;
    };
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

    // Skip SDK agent re-initialization if context was already injected for this session (#1079)
    // The prompt was already saved to the database by /api/sessions/init above —
    // no need to re-start the SDK agent on every turn.
    // Note: we do NOT return here — semantic injection below must run on every prompt.
    const skipAgentInit = Boolean(initResult.contextInjected);
    if (skipAgentInit) {
      logger.info('HOOK', `INIT_COMPLETE | sessionDbId=${sessionDbId} | promptNumber=${promptNumber} | skipped_agent_init=true | reason=context_already_injected`, {
        sessionId: sessionDbId
      });
    }

    // Only initialize SDK agent for Claude Code (not Cursor)
    // Cursor doesn't use the SDK agent - it only needs session/observation storage
    if (!skipAgentInit && input.platform !== 'cursor' && sessionDbId) {
      // Strip leading slash from commands for memory agent
      // /review 101 -> review 101 (more semantic for observations)
      const cleanedPrompt = prompt.startsWith('/') ? prompt.substring(1) : prompt;

      logger.debug('HOOK', 'session-init: Calling /sessions/{sessionDbId}/init', { sessionDbId, promptNumber });

      // Initialize SDK agent session via HTTP (starts the agent!)
      const response = await workerHttpRequest(`/sessions/${sessionDbId}/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userPrompt: cleanedPrompt, promptNumber })
      });

      if (!response.ok) {
        // Log but don't throw - SDK agent failure should not block the user's prompt
        logger.failure('HOOK', `SDK agent start failed: ${response.status}`, { sessionDbId, promptNumber });
      }
    } else if (!skipAgentInit && input.platform === 'cursor') {
      logger.debug('HOOK', 'session-init: Skipping SDK agent init for Cursor platform', { sessionDbId, promptNumber });
    }

    // Semantic context injection: query Chroma for relevant past observations
    // and inject as additionalContext so Claude receives relevant memory each prompt.
    // Controlled by CLAUDE_MEM_SEMANTIC_INJECT setting (default: true).
    const semanticInject =
      String(settings.CLAUDE_MEM_SEMANTIC_INJECT).toLowerCase() === 'true';
    let additionalContext = '';

    if (semanticInject && prompt && prompt.length >= 20 && prompt !== '[media prompt]') {
      try {
        const limit = settings.CLAUDE_MEM_SEMANTIC_INJECT_LIMIT || '5';
        const semanticRes = await workerHttpRequest('/api/context/semantic', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ q: prompt, project, limit })
        });
        if (semanticRes.ok) {
          const data = await semanticRes.json() as { context: string; count: number };
          if (data.context) {
            additionalContext = data.context;
            logger.debug('HOOK', `Semantic injection: ${data.count} observations for prompt`, {
              sessionId: sessionDbId, count: data.count
            });
          }
        }
      } catch (e) {
        // Graceful degradation — semantic injection is optional
        logger.debug('HOOK', 'Semantic injection unavailable', {
          error: e instanceof Error ? e.message : String(e)
        });
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
