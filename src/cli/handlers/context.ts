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
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';

/**
 * Maximum size for additionalContext before truncation.
 * Claude Code saves hookSpecificOutput to session files (saved_hook_context),
 * and large contexts cause the session file to grow, slowing all subsequent
 * hook invocations. 50KB keeps context useful while preventing bloat (#1269).
 */
const MAX_CONTEXT_SIZE_BYTES = 50_000;

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

    // Wait for worker to be fully initialized (DB + search ready).
    // The 'start' hook may restart the worker in parallel, so /api/context/inject
    // can hit the initialization guard and return empty. Poll /api/readiness first.
    const readinessUrl = `http://127.0.0.1:${port}/api/readiness`;
    const readinessStart = Date.now();
    const readinessTimeoutMs = 15_000;
    let ready = false;
    while (Date.now() - readinessStart < readinessTimeoutMs) {
      try {
        const r = await fetch(readinessUrl);
        if (r.ok) { ready = true; break; }
      } catch {
        // Worker not yet listening — retry
      }
      await new Promise(r => setTimeout(r, 500));
    }
    if (!ready) {
      logger.warn('HOOK', 'Worker readiness timed out before context fetch');
    }

    // Check if terminal output should be shown (load settings early)
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const showTerminalOutput = settings.CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT === 'true';

    // Pass all projects (parent + worktree if applicable) for unified timeline
    const projectsParam = context.allProjects.join(',');
    const url = `http://127.0.0.1:${port}/api/context/inject?projects=${encodeURIComponent(projectsParam)}`;

    // Note: Removed AbortSignal.timeout due to Windows Bun cleanup issue (libuv assertion)
    // Worker service has its own timeouts, so client-side timeout is redundant
    try {
      // Fetch markdown (for Claude context) and optionally colored (for user display)
      const colorUrl = `${url}&colors=true`;
      const [response, colorResponse] = await Promise.all([
        fetch(url),
        showTerminalOutput ? fetch(colorUrl).catch(() => null) : Promise.resolve(null)
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

      let additionalContext = contextResult.trim();
      const coloredTimeline = colorResult.trim();

      // Truncate context to prevent saved_hook_context bloat in Claude Code session files (#1269)
      if (additionalContext.length > MAX_CONTEXT_SIZE_BYTES) {
        logger.warn('HOOK', 'Context exceeds 50KB limit, truncating', {
          originalSize: additionalContext.length,
          limit: MAX_CONTEXT_SIZE_BYTES
        });
        additionalContext = additionalContext.slice(0, MAX_CONTEXT_SIZE_BYTES) +
          '\n\n[Context truncated — exceeded 50KB limit. Use mem-search for full history.]';
      }

      const systemMessage = showTerminalOutput && coloredTimeline
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
