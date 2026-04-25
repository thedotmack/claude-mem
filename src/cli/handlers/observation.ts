/**
 * Observation Handler - PostToolUse
 *
 * Extracted from save-hook.ts - sends tool usage to worker for storage.
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { executeWithWorkerFallback, isWorkerFallback } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { shouldTrackProject } from '../../shared/should-track-project.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';

export const observationHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const { sessionId, cwd, toolName, toolInput, toolResponse } = input;
    const platformSource = normalizePlatformSource(input.platform);

    if (!toolName) {
      // No tool name provided - skip observation gracefully
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    const toolStr = logger.formatTool(toolName, toolInput);

    logger.dataIn('HOOK', `PostToolUse: ${toolStr}`, {});

    // Plan 05 Phase 6: cwd is validated at the adapter boundary; the adapter
    // rejects empty cwd before reaching the handler. We still type-narrow for
    // TypeScript and as a belt-and-suspenders guard.
    if (!cwd) {
      throw new Error(`Missing cwd in PostToolUse hook input for session ${sessionId}, tool ${toolName}`);
    }

    // Plan 05 Phase 5: project exclusion via single helper.
    if (!shouldTrackProject(cwd)) {
      logger.debug('HOOK', 'Project excluded from tracking, skipping observation', { cwd, toolName });
      return { continue: true, suppressOutput: true };
    }

    // Plan 05 Phase 2: single helper for ensure-worker-alive → request → fallback.
    const result = await executeWithWorkerFallback<{ status?: string }>(
      '/api/sessions/observations',
      'POST',
      {
        contentSessionId: sessionId,
        platformSource,
        tool_name: toolName,
        tool_input: toolInput,
        tool_response: toolResponse,
        cwd,
        agentId: input.agentId,
        agentType: input.agentType,
      },
    );

    if (isWorkerFallback(result)) {
      // Worker unreachable — fail-loud counter has already been incremented
      // and may have escalated to exit 2. If we got here, threshold not yet
      // reached, so degrade gracefully.
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    logger.debug('HOOK', 'Observation sent successfully', { toolName });
    return { continue: true, suppressOutput: true };
  },
};
