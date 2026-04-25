/**
 * File Edit Handler - Cursor-specific afterFileEdit
 *
 * Handles file edit observations from Cursor IDE.
 * Similar to observation handler but with file-specific metadata.
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { executeWithWorkerFallback, isWorkerFallback } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';

export const fileEditHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const { sessionId, cwd, filePath, edits } = input;
    const platformSource = normalizePlatformSource(input.platform);

    if (!filePath) {
      throw new Error('fileEditHandler requires filePath');
    }

    logger.dataIn('HOOK', `FileEdit: ${filePath}`, {
      editCount: edits?.length ?? 0
    });

    // Plan 05 Phase 6: cwd is validated at the adapter boundary; this is a
    // belt-and-suspenders type guard so TypeScript narrows.
    if (!cwd) {
      throw new Error(`Missing cwd in FileEdit hook input for session ${sessionId}, file ${filePath}`);
    }

    // Plan 05 Phase 2: single helper for ensure-worker-alive → request → fallback.
    const result = await executeWithWorkerFallback<{ status?: string }>(
      '/api/sessions/observations',
      'POST',
      {
        contentSessionId: sessionId,
        platformSource,
        tool_name: 'write_file',
        tool_input: { filePath, edits },
        tool_response: { success: true },
        cwd,
      },
    );

    if (isWorkerFallback(result)) {
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    logger.debug('HOOK', 'File edit observation sent successfully', { filePath });
    return { continue: true, suppressOutput: true };
  },
};
