// IO discipline (see src/shared/hook-io.ts): this handler is PURE. It returns a
// HookResult and MUST NOT write to stdout/stderr or exit.
import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { spoolHookEvent } from '../spool-hook-event.js';
import { logger } from '../../utils/logger.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';
import { shouldTrackProject } from '../../shared/should-track-project.js';
import { resolveRuntimeContext } from '../../services/hooks/runtime-selector.js';
import { captureDeliverables } from '../deliverables-capture.js';

const DONE: HookResult = { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };

/**
 * Claude Code SubagentStop: records that one subagent of this session finished,
 * so My Work stops showing it as working. Input carries session_id, agent_id,
 * agent_type, agent_transcript_path and last_assistant_message; only the
 * session, the agent's identity and the hook's time are kept. Never blocks the
 * stop: it spools the event and returns.
 */
export const subagentStopHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const { sessionId, agentId } = input;
    if (!sessionId || !agentId) {
      logger.debug('HOOK', 'subagent-stop: no session or agent id, skipping', { hasSession: Boolean(sessionId), hasAgent: Boolean(agentId) });
      return DONE;
    }
    if (!shouldTrackProject(input.cwd ?? '')) return DONE;
    if (resolveRuntimeContext().runtime === 'server') return DONE;

    spoolHookEvent('subagent_stop', {
      contentSessionId: sessionId,
      platformSource: normalizePlatformSource(input.platform),
      agentId,
      ...(input.agentType ? { agentType: input.agentType } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
    });
    // A subagent that made a deck or a report hands it to the session: its own
    // transcript is one run, scanned whole with its sidechain entries (every
    // entry in it is one). Failure-isolated.
    if (input.agentTranscriptPath) {
      try {
        captureDeliverables(input, { subagentTranscriptPath: input.agentTranscriptPath });
      } catch (err) {
        logger.warn('HOOK', 'Deliverables capture failed for a subagent; its stop is still recorded', {
          sessionId, agentId, error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return DONE;
  },
};
