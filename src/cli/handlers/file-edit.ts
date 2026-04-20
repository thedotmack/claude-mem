/**
 * File Edit Handler - Cursor-specific afterFileEdit
 *
 * Handles file edit observations from Cursor IDE.
 * Similar to observation handler but with file-specific metadata.
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { ensureWorkerRunning, workerHttpRequest } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';

async function sendFileEditObservation(requestBody: string, filePath: string): Promise<void> {
  const response = await workerHttpRequest('/api/sessions/observations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: requestBody
  });

  if (!response.ok) {
    logger.warn('HOOK', 'File edit observation storage failed, skipping', { status: response.status, filePath });
    return;
  }

  logger.debug('HOOK', 'File edit observation sent successfully', { filePath });
}

export const fileEditHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    // Ensure worker is running before any other logic
    const workerReady = await ensureWorkerRunning();
    if (!workerReady) {
      // Worker not available - skip file edit observation gracefully
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    const { sessionId, cwd, filePath, edits } = input;
    const platformSource = normalizePlatformSource(input.platform);

    if (!filePath) {
      throw new Error('fileEditHandler requires filePath');
    }

    logger.dataIn('HOOK', `FileEdit: ${filePath}`, {
      editCount: edits?.length ?? 0
    });

    // Validate required fields before sending to worker
    if (!cwd) {
      throw new Error(`Missing cwd in FileEdit hook input for session ${sessionId}, file ${filePath}`);
    }

    // Send to worker as an observation with file edit metadata
    // The observation handler on the worker will process this appropriately
    const requestBody = JSON.stringify({
      contentSessionId: sessionId,
      platformSource,
      tool_name: 'write_file',
      tool_input: { filePath, edits },
      tool_response: { success: true },
      cwd
    });

    try {
      await sendFileEditObservation(requestBody, filePath);
    } catch (error) {
      // Worker unreachable — skip file edit observation gracefully
      logger.warn('HOOK', 'File edit observation fetch error, skipping', { error: error instanceof Error ? error.message : String(error) });
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    return { continue: true, suppressOutput: true };
  }
};
