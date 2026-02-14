/**
 * Context Handler - SessionStart
 *
 * Extracted from context-hook.ts - calls worker to generate context.
 * Returns context as hookSpecificOutput for Claude Code to inject.
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { ensureWorkerRunning, getWorkerPort, fetchWithTimeout } from '../../shared/worker-utils.js';
import { getProjectContext } from '../../utils/project-name.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { logger } from '../../utils/logger.js';

export const contextHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    // Ensure worker is running before any other logic
    const workerReady = await ensureWorkerRunning();
    if (!workerReady) {
      // Worker not available - return empty context gracefully
      return {
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: ''
        },
        exitCode: HOOK_EXIT_CODES.SUCCESS
      };
    }

    const cwd = input.cwd ?? process.cwd();
    const context = getProjectContext(cwd);
    const port = getWorkerPort();

    // Pass all projects (parent + worktree if applicable) for unified timeline
    const projectsParam = context.allProjects.join(',');
    const url = `http://127.0.0.1:${port}/api/context/inject?projects=${encodeURIComponent(projectsParam)}`;

    // Use fetchWithTimeout to prevent indefinite hangs (Issue #1079)
    // 15s timeout: generous enough for context generation but prevents hook from blocking forever
    try {
      const response = await fetchWithTimeout(url, {}, 15000);

      if (!response.ok) {
        // Log but don't throw — context fetch failure should not block session start
        logger.warn('HOOK', 'Context generation failed, returning empty', { status: response.status });
        return {
          hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '' },
          exitCode: HOOK_EXIT_CODES.SUCCESS
        };
      }

      const result = await response.text();
      const additionalContext = result.trim();

      return {
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext
        }
      };
    } catch (error) {
      // Worker unreachable — return empty context gracefully
      logger.warn('HOOK', 'Context fetch error, returning empty', { error: error instanceof Error ? error.message : String(error) });
      return {
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '' },
        exitCode: HOOK_EXIT_CODES.SUCCESS
      };
    }
  }
};
