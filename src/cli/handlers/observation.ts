/**
 * Observation Handler - PostToolUse
 *
 * Extracted from save-hook.ts - sends tool usage to worker for storage.
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { ensureWorkerRunning, getWorkerPort } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';

/** Lazily loaded and cached skip tools set */
let skipToolsCache: Set<string> | null = null;

function getSkipTools(): Set<string> {
  if (!skipToolsCache) {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const raw = settings.CLAUDE_MEM_SKIP_TOOLS || '';
    skipToolsCache = new Set(raw.split(',').map(s => s.trim()).filter(Boolean));
  }
  return skipToolsCache;
}

export const observationHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const { sessionId, cwd, toolName, toolInput, toolResponse } = input;

    if (!toolName) {
      throw new Error('observationHandler requires toolName');
    }

    // Check skip list before worker startup or HTTP call
    if (getSkipTools().has(toolName)) {
      logger.debug('HOOK', `Skipping tool: ${toolName}`);
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    // Ensure worker is running before any other logic
    const workerReady = await ensureWorkerRunning();
    if (!workerReady) {
      // Worker not available - skip observation gracefully
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
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
