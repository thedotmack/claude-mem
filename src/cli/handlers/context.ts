/**
 * Context Handler - SessionStart
 *
 * Extracted from context-hook.ts - calls worker to generate context.
 * Returns context as hookSpecificOutput for Claude Code to inject.
 * Worker/DB init is non-blocking: if worker is not ready, we return empty context
 * so Claude UI loads immediately (fixes #923).
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { getWorkerPort } from '../../shared/worker-utils.js';
import { getProjectContext } from '../../utils/project-name.js';
import { logger } from '../../utils/logger.js';

export const contextHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const cwd = input.cwd ?? process.cwd();
    const context = getProjectContext(cwd);
    const port = getWorkerPort();

    // Pass all projects (parent + worktree if applicable) for unified timeline
    const projectsParam = context.allProjects.join(',');
    const url = `http://127.0.0.1:${port}/api/context/inject?projects=${encodeURIComponent(projectsParam)}`;

    // Non-blocking: try fetch; if worker not ready, return empty and let Claude load
    try {
      const response = await fetch(url);
      if (!response.ok) {
        logger.warn('SYSTEM', 'Worker not ready, continuing without mem', { status: response.status });
        return {
          hookSpecificOutput: {
            hookEventName: 'SessionStart',
            additionalContext: ''
          }
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
    } catch (err) {
      logger.warn('SYSTEM', 'Worker not ready, continuing without mem', {}, err as Error);
      return {
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: ''
        }
      };
    }
  }
};
