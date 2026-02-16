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

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 500;

async function fetchWithRetry(url: string, options: RequestInit, label: string): Promise<Response> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, options);
      if (response.ok || response.status < 500) {
        return response;
      }
      lastError = new Error(`${label} failed: ${String(response.status)}`);
      logger.info('HOOK', `${label} returned ${String(response.status)}, attempt ${String(attempt + 1)}/${String(MAX_RETRIES)}`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      logger.info('HOOK', `${label} connection error, attempt ${String(attempt + 1)}/${String(MAX_RETRIES)}`);
    }
    if (attempt < MAX_RETRIES - 1) {
      const delay = INITIAL_BACKOFF_MS * 2 ** attempt;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError ?? new Error(`${label} failed after ${String(MAX_RETRIES)} attempts`);
}

export const sessionInitHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    // Ensure worker is running before any other logic
    const workerReady = await ensureWorkerRunning();
    if (!workerReady) {
      // Worker not available - skip session init gracefully
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    const { sessionId, cwd, prompt } = input;

    if (!prompt) {
      throw new Error('sessionInitHandler requires prompt');
    }

    const project = getProjectName(cwd);
    const port = getWorkerPort();

    logger.debug('HOOK', 'session-init: Calling /api/sessions/init', { contentSessionId: sessionId, project });

    // Initialize session via HTTP - handles DB operations and privacy checks
    // Retries with backoff handle transient 503s during worker startup
    const initResponse = await fetchWithRetry(
      `http://127.0.0.1:${String(port)}/api/sessions/init`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contentSessionId: sessionId,
          project,
          prompt
        })
      },
      'Session initialization'
    );

    if (!initResponse.ok) {
      throw new Error(`Session initialization failed: ${String(initResponse.status)}`);
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
    logger.debug('HOOK', `[ALIGNMENT] Hook Entry | contentSessionId=${sessionId} | prompt#=${String(promptNumber)} | sessionDbId=${String(sessionDbId)}`);

    // Check if prompt was entirely private (worker performs privacy check)
    if (initResult.skipped && initResult.reason === 'private') {
      logger.info('HOOK', `INIT_COMPLETE | sessionDbId=${String(sessionDbId)} | promptNumber=${String(promptNumber)} | skipped=true | reason=private`, {
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
      // Retries with backoff handle transient 503s during worker startup
      const response = await fetchWithRetry(
        `http://127.0.0.1:${String(port)}/sessions/${String(sessionDbId)}/init`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userPrompt: cleanedPrompt, promptNumber })
        },
        'SDK agent start'
      );

      if (!response.ok) {
        throw new Error(`SDK agent start failed: ${String(response.status)}`);
      }
    } else if (input.platform === 'cursor') {
      logger.debug('HOOK', 'session-init: Skipping SDK agent init for Cursor platform', { sessionDbId, promptNumber });
    }

    logger.info('HOOK', `INIT_COMPLETE | sessionDbId=${String(sessionDbId)} | promptNumber=${String(promptNumber)} | project=${project}`, {
      sessionId: sessionDbId
    });

    return { continue: true, suppressOutput: true };
  }
};
