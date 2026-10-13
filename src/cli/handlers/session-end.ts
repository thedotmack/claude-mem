// IO discipline (see src/shared/hook-io.ts): this handler is PURE. It returns a
// HookResult and MUST NOT call process.stderr.write / process.stdout.write /
// console.* / process.exit. logger.* calls are DIAGNOSTIC; thrown errors are
// caught by hookCommand, logged, and answered with a no-op (never exit 2).
import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { spoolHookEvent } from '../spool-hook-event.js';
import { logger } from '../../utils/logger.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';
import { resolveRuntimeContext } from '../../services/hooks/runtime-selector.js';

// Claude Code gives plugin SessionEnd hooks a 1.5-second budget, so this hook
// only spools the request and pokes the worker; it never waits on the worker.

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

    // Keyed on (session, platform) only — the worker uses nothing else — so a
    // SessionEnd re-delivered with another reason still overwrites one entry.
    spoolHookEvent('session_end', { contentSessionId: sessionId, platformSource });

    logger.debug('HOOK', 'Session-end request spooled, exiting hook');
    return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
  },
};
