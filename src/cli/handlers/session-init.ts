/**
 * Session Init Handler - UserPromptSubmit
 *
 * Extracted from new-hook.ts - initializes session and starts SDK agent.
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { ensureWorkerRunning, getWorkerPort } from '../../shared/worker-utils.js';
import { getProjectName } from '../../utils/project-name.js';
import { logger } from '../../utils/logger.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { isProjectExcluded } from '../../utils/project-filter.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';

export const sessionInitHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    // Ensure worker is running before any other logic
    const workerReady = await ensureWorkerRunning();
    if (!workerReady) {
      // Worker not available - skip session init gracefully
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    const { sessionId, cwd, prompt: rawPrompt } = input;

    // Check if project is excluded from tracking
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    if (cwd && isProjectExcluded(cwd, settings.CLAUDE_MEM_EXCLUDED_PROJECTS)) {
      logger.info('HOOK', 'Project excluded from tracking', { cwd });
      return { continue: true, suppressOutput: true };
    }

    // Handle image-only prompts (where text prompt is empty/undefined)
    // Use placeholder so sessions still get created and tracked for memory
    const prompt = (!rawPrompt || !rawPrompt.trim()) ? '[media prompt]' : rawPrompt;

    const project = getProjectName(cwd);
    const port = getWorkerPort();

    logger.debug('HOOK', 'session-init: Calling /api/sessions/init', { contentSessionId: sessionId, project });

    // Initialize session via HTTP - handles DB operations and privacy checks
    const initResponse = await fetch(`http://127.0.0.1:${port}/api/sessions/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contentSessionId: sessionId,
        project,
        prompt
      })
      // Note: Removed signal to avoid Windows Bun cleanup issue (libuv assertion)
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
    };
    const sessionDbId = initResult.sessionDbId;
    const promptNumber = initResult.promptNumber;

    logger.debug('HOOK', 'session-init: Received from /api/sessions/init', { sessionDbId, promptNumber, skipped: initResult.skipped });

    // Debug-level alignment log for detailed tracing
    logger.debug('HOOK', `[ALIGNMENT] Hook Entry | contentSessionId=${sessionId} | prompt#=${promptNumber} | sessionDbId=${sessionDbId}`);

    // Check if prompt was entirely private (worker performs privacy check)
    if (initResult.skipped && initResult.reason === 'private') {
      logger.info('HOOK', `INIT_COMPLETE | sessionDbId=${sessionDbId} | promptNumber=${promptNumber} | skipped=true | reason=private`, {
        sessionId: sessionDbId
      });
      return { continue: true, suppressOutput: true };
    }

    // Only initialize SDK agent for Claude Code (not Cursor)
    // Cursor doesn't use the SDK agent - it only needs session/observation storage
    if (input.platform !== 'cursor' && sessionDbId) {
      // Strip leading slash from commands for memory agent
      // /review 101 -> review 101 (more semantic for observations)
      const cleanedPrompt = prompt.startsWith('/') ? prompt.substring(1) : prompt;

      logger.debug('HOOK', 'session-init: Calling /sessions/{sessionDbId}/init', { sessionDbId, promptNumber });

      // Initialize SDK agent session via HTTP (starts the agent!)
      const response = await fetch(`http://127.0.0.1:${port}/sessions/${sessionDbId}/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userPrompt: cleanedPrompt, promptNumber })
        // Note: Removed signal to avoid Windows Bun cleanup issue (libuv assertion)
      });

      if (!response.ok) {
        // Log but don't throw - SDK agent failure should not block the user's prompt
        logger.failure('HOOK', `SDK agent start failed: ${response.status}`, { sessionDbId, promptNumber });
      }
    } else if (input.platform === 'cursor') {
      logger.debug('HOOK', 'session-init: Skipping SDK agent init for Cursor platform', { sessionDbId, promptNumber });
    }

    logger.info('HOOK', `INIT_COMPLETE | sessionDbId=${sessionDbId} | promptNumber=${promptNumber} | project=${project}`, {
      sessionId: sessionDbId
    });

    return { continue: true, suppressOutput: true };
  }
};
