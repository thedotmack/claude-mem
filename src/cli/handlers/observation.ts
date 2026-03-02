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
import { loadHubConfig, resolveProjectFromFilePath } from '../../utils/project-name.js';
import { extractFilePathsFromTool } from '../../utils/file-path-extractor.js';
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
      // No tool name provided - skip observation gracefully
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

    // Check if project is excluded from tracking
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    if (isProjectExcluded(cwd, settings.CLAUDE_MEM_EXCLUDED_PROJECTS)) {
      logger.debug('HOOK', 'Project excluded from tracking, skipping observation', { cwd, toolName });
      return { continue: true, suppressOutput: true };
    }

    // Hub mode: resolve project from file paths instead of cwd basename
    let projectOverride: string | undefined;
    const hubConfig = loadHubConfig(cwd);
    if (hubConfig) {
      const filePaths = extractFilePathsFromTool(toolName, toolInput, toolResponse);
      if (filePaths.length > 0) {
        // Use the first file path to determine the project
        projectOverride = resolveProjectFromFilePath(filePaths[0], cwd, hubConfig);
        logger.debug('HOOK', 'Hub mode: resolved project from file path', {
          toolName,
          filePath: filePaths[0],
          project: projectOverride
        });
      } else {
        projectOverride = hubConfig.default_project;
      }
    }

    // Send to worker - worker handles privacy check and database operations
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/sessions/observations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contentSessionId: sessionId,
          tool_name: toolName,
          tool_input: toolInput,
          tool_response: toolResponse,
          cwd,
          ...(projectOverride ? { project_override: projectOverride } : {})
        })
        // Note: Removed signal to avoid Windows Bun cleanup issue (libuv assertion)
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
