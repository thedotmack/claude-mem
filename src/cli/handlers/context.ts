/**
 * Context Handler - SessionStart
 *
 * Extracted from context-hook.ts - calls worker to generate context.
 * Returns context as hookSpecificOutput for Claude Code to inject.
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { ensureWorkerRunning, getWorkerPort } from '../../shared/worker-utils.js';
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

    // Note: Removed AbortSignal.timeout due to Windows Bun cleanup issue (libuv assertion)
    // Worker service has its own timeouts, so client-side timeout is redundant
    try {
      // Fetch both markdown (for Claude context) and colored (for user display) truly in parallel
      const colorUrl = `${url}&colors=true`;
      const [response, colorResponse] = await Promise.all([
        fetch(url),
        fetch(colorUrl).catch(() => null)
      ]);

      if (!response.ok) {
        // Log but don't throw — context fetch failure should not block session start
        logger.warn('HOOK', 'Context generation failed, returning empty', { status: response.status });
        return {
          hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '' },
          exitCode: HOOK_EXIT_CODES.SUCCESS
        };
      }

      const [contextResult, colorResult] = await Promise.all([
        response.text(),
        colorResponse?.ok ? colorResponse.text() : Promise.resolve('')
      ]);

      const additionalContext = contextResult.trim();
      const coloredTimeline = colorResult.trim();
      const systemMessage = coloredTimeline
        ? `${coloredTimeline}\n\nView Observations Live @ http://localhost:${port}`
        : undefined;

      return {
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext
        },
        systemMessage
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
