// IO discipline (see src/shared/hook-io.ts): this handler is PURE. It returns a
// HookResult and MUST NOT call process.stderr.write / process.stdout.write /
// console.* / process.exit. logger.* calls are DIAGNOSTIC; thrown errors are
// caught by hookCommand and routed through emitBlockingError.
import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { executeWithWorkerFallback, isWorkerFallback } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';

// SessionEnd (#3073). Claude Code never had an end-of-session hook, so the
// persistent worker only ever learned a session was over indirectly (when its
// generator happened to exit). This handler gives the worker an explicit
// signal so it can finalize and reap that session's in-flight work (abort the
// generator, reap the SDK subprocess, flush) instead of leaving it to orphan.
//
// Best-effort by design: it never blocks session teardown and never surfaces an
// error. If the worker isn't running there is nothing to reap, so the fallback
// is a clean no-op.
export const sessionEndHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const { sessionId } = input;

    if (!sessionId) {
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    // Subagent sessions share the parent's worker session; a subagent ending
    // must not tear that down. Only the top-level session end reaps.
    if (input.agentId) {
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    const platformSource = normalizePlatformSource(input.platform);

    const result = await executeWithWorkerFallback<{ status?: string; reaped?: boolean }>(
      '/api/sessions/end',
      'POST',
      {
        contentSessionId: sessionId,
        platformSource,
      },
    );

    if (isWorkerFallback(result)) {
      // Worker not running — nothing to reap.
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    logger.debug('HOOK', 'SessionEnd signal delivered to worker', { sessionId });
    return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
  },
};
