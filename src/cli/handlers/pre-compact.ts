
import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { executeWithWorkerFallback, isWorkerFallback } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { shouldTrackProject } from '../../shared/should-track-project.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';

export const preCompactHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const enabled = process.env.CLAUDE_MEM_PRECOMPACT_ENABLED;
    if (enabled !== 'true' && enabled !== '1') {
      logger.debug('HOOK', 'PreCompact hook disabled by default. Set CLAUDE_MEM_PRECOMPACT_ENABLED=true to enable');
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    const { sessionId, cwd } = input;

    if (!sessionId) {
      logger.warn('HOOK', 'pre-compact: No sessionId provided, skipping');
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    if (cwd && !shouldTrackProject(cwd)) {
      logger.debug('HOOK', 'Project excluded from tracking, skipping pre-compact', { cwd });
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    if (input.agentId) {
      logger.debug('HOOK', 'Skipping pre-compact: subagent context detected', {
        sessionId,
        agentId: input.agentId,
        agentType: input.agentType
      });
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    const platformSource = normalizePlatformSource(input.platform);

    logger.info('HOOK', 'PreCompact: capturing session state before compaction', {
      sessionId,
      platformSource,
      cwd
    });

    const result = await executeWithWorkerFallback<{ status?: string }>(
      '/api/sessions/pre-compact',
      'POST',
      {
        contentSessionId: sessionId,
        platformSource,
        cwd,
      },
    );

    if (isWorkerFallback(result)) {
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    logger.debug('HOOK', 'PreCompact request queued, exiting hook');
    return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
  },
};
