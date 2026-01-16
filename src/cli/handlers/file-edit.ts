/**
 * File Edit Handler - Cursor-specific afterFileEdit
 *
 * Handles file edit observations from Cursor IDE.
 * Similar to observation handler but with file-specific metadata.
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { ensureWorkerRunning, getWorkerPort } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';

export const fileEditHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    // Ensure worker is running before any other logic
    const workerReady = await ensureWorkerRunning();
    if (!workerReady) {
      // Worker not available - skip file edit observation gracefully
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    const { sessionId, cwd, filePath, edits } = input;

    if (!filePath) {
      throw new Error('fileEditHandler requires filePath');
    }

    const port = getWorkerPort();

    logger.dataIn('HOOK', `FileEdit: ${filePath}`, {
      workerPort: port,
      editCount: edits?.length ?? 0
    });

    // Validate required fields before sending to worker
    if (!cwd) {
      throw new Error(`Missing cwd in FileEdit hook input for session ${sessionId}, file ${filePath}`);
    }

    // Send to worker as an observation with file edit metadata
    // The observation handler on the worker will process this appropriately
    const response = await fetch(`http://127.0.0.1:${port}/api/sessions/observations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contentSessionId: sessionId,
        tool_name: 'write_file',
        tool_input: { filePath, edits },
        tool_response: { success: true },
        cwd
      })
      // Note: Removed signal to avoid Windows Bun cleanup issue (libuv assertion)
    });

    if (!response.ok) {
      throw new Error(`File edit observation storage failed: ${response.status}`);
    }

    logger.debug('HOOK', 'File edit observation sent successfully', { filePath });

    return { continue: true, suppressOutput: true };
  }
};
