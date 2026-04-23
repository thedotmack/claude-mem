/**
 * Session Complete Handler - Stop (Phase 2)
 *
 * Completes the session after summarize has been queued.
 * This removes the session from the active sessions map, allowing
 * the orphan reaper to clean up any remaining subprocess.
 *
 * Fixes Issue #842: Orphan reaper starts but never reaps because
 * sessions stay in the active sessions map forever.
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { executeWithWorkerFallback, isWorkerFallback } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';

export const sessionCompleteHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const { sessionId } = input;
    const platformSource = normalizePlatformSource(input.platform);

    if (!sessionId) {
      logger.warn('HOOK', 'session-complete: Missing sessionId, skipping');
      return { continue: true, suppressOutput: true };
    }

    logger.info('HOOK', '→ session-complete: Removing session from active map', {
      contentSessionId: sessionId,
    });

    // Plan 05 Phase 2: single helper for ensure-worker-alive → request → fallback.
    const result = await executeWithWorkerFallback<{ status?: string }>(
      '/api/sessions/complete',
      'POST',
      { contentSessionId: sessionId, platformSource },
    );

    if (isWorkerFallback(result)) {
      return { continue: true, suppressOutput: true };
    }

    logger.info('HOOK', 'Session completed successfully', { contentSessionId: sessionId });
    return { continue: true, suppressOutput: true };
  },
};
