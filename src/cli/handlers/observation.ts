/**
 * Observation Handler - PostToolUse
 *
 * Sends tool usage to worker for storage, and optionally performs
 * associative memory recall ("thought-triggered actions") — querying
 * past observations for semantic similarity to the current tool output
 * and injecting relevant memories as additionalContext.
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { ensureWorkerRunning, workerHttpRequest } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { isProjectExcluded } from '../../utils/project-filter.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';
import { getProjectName } from '../../utils/project-name.js';

/**
 * Extract a search signal from tool input/output for associative search.
 * Returns a string suitable for vector similarity search, or empty string if not worth searching.
 */
function extractSearchSignal(toolName: string, toolInput: unknown, toolResponse: unknown): string {
  const parts: string[] = [];

  // Extract meaningful text from tool input
  if (toolInput && typeof toolInput === 'object') {
    const input = toolInput as Record<string, unknown>;
    // File reads: the file path + content is the signal
    if (input.file_path) parts.push(String(input.file_path));
    if (input.pattern) parts.push(String(input.pattern));
    if (input.command) parts.push(String(input.command));
    if (input.query) parts.push(String(input.query));
    if (input.prompt) parts.push(String(input.prompt));
  } else if (typeof toolInput === 'string') {
    parts.push(toolInput);
  }

  // Extract text from tool response (truncated for performance)
  if (typeof toolResponse === 'string') {
    // Take first 500 chars of response to keep the search signal focused
    parts.push(toolResponse.slice(0, 500));
  } else if (toolResponse && typeof toolResponse === 'object') {
    const resp = toolResponse as Record<string, unknown>;
    if (resp.content && typeof resp.content === 'string') {
      parts.push(resp.content.slice(0, 500));
    } else if (resp.output && typeof resp.output === 'string') {
      parts.push(resp.output.slice(0, 500));
    }
  }

  return parts.join(' ').trim();
}

export const observationHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    // Ensure worker is running before any other logic
    const workerReady = await ensureWorkerRunning();
    if (!workerReady) {
      // Worker not available - skip observation gracefully
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    const { sessionId, cwd, toolName, toolInput, toolResponse } = input;
    const platformSource = normalizePlatformSource(input.platform);

    if (!toolName) {
      // No tool name provided - skip observation gracefully
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    const toolStr = logger.formatTool(toolName, toolInput);

    logger.dataIn('HOOK', `PostToolUse: ${toolStr}`, {});

    // Validate required fields before sending to worker
    if (!cwd) {
      throw new Error(`Missing cwd in PostToolUse hook input for session ${sessionId}, tool ${toolName}`);
    }

    // Check if project is excluded from tracking
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    if (isProjectExcluded(cwd, settings.CLAUDE_MEM_EXCLUDED_PROJECTS)) {
      logger.debug('HOOK', 'Project excluded from tracking, skipping observation', { cwd, toolName });
      return { continue: true, suppressOutput: true };
    }

    // Fire observation storage (non-blocking for thought actions path)
    const observationPromise = (async () => {
      try {
        const response = await workerHttpRequest('/api/sessions/observations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contentSessionId: sessionId,
            platformSource,
            tool_name: toolName,
            tool_input: toolInput,
            tool_response: toolResponse,
            cwd
          })
        });

        if (!response.ok) {
          logger.warn('HOOK', 'Observation storage failed, skipping', { status: response.status, toolName });
        } else {
          logger.debug('HOOK', 'Observation sent successfully', { toolName });
        }
      } catch (error) {
        logger.warn('HOOK', 'Observation fetch error, skipping', { error: error instanceof Error ? error.message : String(error) });
      }
    })();

    // Thought-triggered actions: associative memory recall
    const thoughtActionsEnabled =
      String(settings.CLAUDE_MEM_THOUGHT_ACTIONS_ENABLED).toLowerCase() === 'true';

    if (!thoughtActionsEnabled) {
      // Wait for observation storage then return without context injection
      await observationPromise;
      return { continue: true, suppressOutput: true };
    }

    // Extract search signal from tool input/output
    const minInput = parseInt(settings.CLAUDE_MEM_THOUGHT_ACTIONS_MIN_INPUT || '50', 10);
    const searchSignal = extractSearchSignal(toolName, toolInput, toolResponse);

    if (searchSignal.length < minInput) {
      await observationPromise;
      return { continue: true, suppressOutput: true };
    }

    // Run associative search in parallel with observation storage
    const timeout = parseInt(settings.CLAUDE_MEM_THOUGHT_ACTIONS_TIMEOUT || '1500', 10);
    const limit = parseInt(settings.CLAUDE_MEM_THOUGHT_ACTIONS_LIMIT || '3', 10);
    const threshold = parseFloat(settings.CLAUDE_MEM_THOUGHT_ACTIONS_THRESHOLD || '1.2');
    const project = getProjectName(cwd);

    let additionalContext = '';

    try {
      const associativePromise = workerHttpRequest('/api/context/associative', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: searchSignal,
          project,
          limit,
          threshold
        })
      });

      // Race against timeout to keep hook fast
      const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeout));
      const result = await Promise.race([associativePromise, timeoutPromise]);

      if (result && result.ok) {
        const data = await result.json() as { context: string; count: number };
        if (data.context && data.count > 0) {
          additionalContext = data.context;
          logger.info('HOOK', `Thought-triggered: ${data.count} memories recalled for ${toolName}`, {
            count: data.count, toolName
          });
        }
      } else if (result === null) {
        logger.debug('HOOK', 'Associative search timed out, skipping', { toolName, timeout });
      }
    } catch (error) {
      // Graceful degradation — associative search is optional
      logger.debug('HOOK', 'Associative search failed, skipping', {
        error: error instanceof Error ? error.message : String(error)
      });
    }

    // Wait for observation storage to complete
    await observationPromise;

    // Return with associative context if found
    if (additionalContext) {
      return {
        continue: true,
        suppressOutput: true,
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext
        }
      };
    }

    return { continue: true, suppressOutput: true };
  }
};
