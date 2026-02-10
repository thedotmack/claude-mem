/**
 * Context Handler - SessionStart
 *
 * Extracted from context-hook.ts - calls worker to generate context.
 * Returns context as hookSpecificOutput for Claude Code to inject.
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { ensureWorkerRunning, getWorkerPort, buildWorkerUrl } from '../../shared/worker-utils.js';
import { getProjectContext } from '../../utils/project-name.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { stripInternalAgentMarkers } from '../../utils/tag-stripping.js';

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
    const url = buildWorkerUrl(`/api/context/inject?projects=${encodeURIComponent(projectsParam)}`);

    // Note: Removed AbortSignal.timeout due to Windows Bun cleanup issue (libuv assertion)
    // Worker service has its own timeouts, so client-side timeout is redundant
    try {
      const response = await fetch(url);

      if (!response.ok) {
        // Return empty context on failure - don't block the user's session (Issue #897)
        return {
          hookSpecificOutput: {
            hookEventName: 'SessionStart',
            additionalContext: ''
          },
          exitCode: HOOK_EXIT_CODES.SUCCESS
        };
      }

      const result = await response.text();
      // Strip any internal agent markers that might leak into context (#784)
      const additionalContext = stripInternalAgentMarkers(result);

      return {
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext
        }
      };
    } catch {
      // Network error (worker crashed, port unavailable, etc.) - return empty context gracefully
      return {
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: ''
        },
        exitCode: HOOK_EXIT_CODES.SUCCESS
      };
    }
  }
};
