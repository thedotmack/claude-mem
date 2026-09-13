// IO discipline (see src/shared/hook-io.ts): this handler is PURE. It returns a
// HookResult and MUST NOT call process.stderr.write / process.stdout.write /
// console.* / process.exit. logger.* calls are DIAGNOSTIC; thrown errors are
// caught by hookCommand and routed through emitBlockingError.
import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { executeWithWorkerFallback, isWorkerFallback } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';
import { resolveRuntimeContext } from '../../services/hooks/runtime-selector.js';

export const sessionEndHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const { sessionId } = input;

    if (!sessionId) {
      logger.warn('HOOK', 'session-end: No sessionId provided, skipping');
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    const platformSource = normalizePlatformSource(input.platform);
    const runtime = resolveRuntimeContext();
    if (runtime.runtime === 'server') {
      logger.debug('HOOK', 'session-end: Server runtime handling is not implemented, skipping', {
        sessionId,
      });
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    const result = await executeWithWorkerFallback<{ status?: string }>(
      '/api/sessions/session-end',
      'POST',
      {
        contentSessionId: sessionId,
        platformSource,
        reason: input.reason,
        cwd: input.cwd,
      },
    );
    if (isWorkerFallback(result)) {
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    logger.debug('HOOK', 'Session-end request queued, exiting hook');
    return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
  },
};
