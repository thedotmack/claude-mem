/**
 * Observation Handler - PostToolUse
 *
 * Extracted from save-hook.ts - sends tool usage to worker for storage.
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { ensureWorkerRunning, workerHttpRequest } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { isProjectExcluded } from '../../utils/project-filter.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';

// --- Payload truncation to prevent database bloat (P2 patch) ---
const MAX_INPUT_CHARS = 50 * 1024;   // ~50K characters
const MAX_RESPONSE_CHARS = 100 * 1024; // ~100K characters
const LIGHTWEIGHT_INPUT_CHARS = 1024;  // ~1K characters for low-value tools
const LIGHTWEIGHT_TOOLS = new Set(['Read', 'Glob', 'Grep', 'Ls', 'ListMcpResourcesTool']);

export function truncatePayload(text: string | undefined, maxChars: number): string {
  if (!text) return '';
  if (text.length <= maxChars) return text;
  const truncated = text.slice(0, maxChars);
  return truncated + `\n... [truncated, ${(text.length - maxChars).toLocaleString()} chars omitted]`;
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

    // Send to worker - worker handles privacy check and database operations
    const isLightweight = LIGHTWEIGHT_TOOLS.has(toolName);

    try {
      const response = await workerHttpRequest('/api/sessions/observations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contentSessionId: sessionId,
          platformSource,
          tool_name: toolName,
          tool_input: truncatePayload(toolInput, isLightweight ? LIGHTWEIGHT_INPUT_CHARS : MAX_INPUT_CHARS),
          tool_response: isLightweight ? '' : truncatePayload(toolResponse, MAX_RESPONSE_CHARS),
          cwd
        })
      });

      if (!response.ok) {
        // Log but don't throw — observation storage failure should not block tool use
        logger.warn('HOOK', 'Observation storage failed, skipping', { status: response.status, toolName });
        return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
      }

      logger.debug('HOOK', 'Observation sent successfully', { toolName });
    } catch (error) {
      // Worker unreachable — skip observation gracefully
      logger.warn('HOOK', 'Observation fetch error, skipping', { error: error instanceof Error ? error.message : String(error) });
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    return { continue: true, suppressOutput: true };
  }
};
