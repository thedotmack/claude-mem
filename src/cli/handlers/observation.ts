/**
 * Observation Handler - PostToolUse
 *
 * Sends tool usage to worker for storage using fire-and-forget HTTP.
 * Waits only for TCP write flush (~1-5ms) instead of full response (~300ms+).
 * Failures are tracked in a health file and reported at UserPromptSubmit.
 */

import http from 'http';
import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { ensureWorkerRunning, getWorkerPort } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { recordObservationFailure, recordObservationSuccess } from '../observation-health.js';

/** Lazily loaded and cached skip tools set */
let skipToolsCache: Set<string> | null = null;

function getSkipTools(): Set<string> {
  if (!skipToolsCache) {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const raw = settings.MAGIC_CLAUDE_MEM_SKIP_TOOLS || '';
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
      recordObservationFailure('Worker not available');
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

    const body = JSON.stringify({
      contentSessionId: sessionId,
      tool_name: toolName,
      tool_input: toolInput,
      tool_response: toolResponse,
      cwd
    });

    // Fire-and-forget HTTP POST — wait only for TCP write flush, not response
    await new Promise<void>(resolve => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/api/sessions/observations',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      });

      req.on('finish', () => {
        // TCP write flushed — observation is in-flight
        recordObservationSuccess();
        resolve();
      });

      req.on('error', (err) => {
        recordObservationFailure(err.message);
        resolve();
      });

      // Safety cap — don't block Claude even if TCP stalls
      setTimeout(resolve, 100);

      req.write(body);
      req.end();
    });

    logger.debug('HOOK', 'Observation fired (async)', { toolName });

    return { continue: true, suppressOutput: true };
  }
};
