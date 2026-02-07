/**
 * Observation Handler - PostToolUse
 *
 * Extracted from save-hook.ts - sends tool usage to worker for storage.
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { ensureWorkerRunning, getWorkerPort } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { isProjectExcluded } from '../../utils/project-filter.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';

export const observationHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    // Ensure worker is running before any other logic
    const workerReady = await ensureWorkerRunning();
    if (!workerReady) {
      // Worker not available - skip observation gracefully
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    const { sessionId, cwd, toolName, toolInput, toolResponse } = input;

    if (!toolName) {
      throw new Error('observationHandler requires toolName');
    }

    const port = getWorkerPort();

    const toolStr = logger.formatTool(toolName, toolInput);

    logger.dataIn('HOOK', `PostToolUse: ${toolStr}`, {
      workerPort: port
    });

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

    // Send to worker - worker handles privacy check and database operations
    const response = await fetch(`http://127.0.0.1:${port}/api/sessions/observations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contentSessionId: sessionId,
        tool_name: toolName,
        tool_input: toolInput,
        tool_response: toolResponse,
        cwd
      })
      // Note: Removed signal to avoid Windows Bun cleanup issue (libuv assertion)
    });

    if (!response.ok) {
      throw new Error(`Observation storage failed: ${response.status}`);
    }

    logger.debug('HOOK', 'Observation sent successfully', { toolName });

    return { continue: true, suppressOutput: true };
  }
};
