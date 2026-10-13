// IO discipline (see src/shared/hook-io.ts): this handler is PURE. It returns a
// HookResult and MUST NOT call process.stderr.write / process.stdout.write /
// console.* / process.exit.
//
// Codex PostCompact: the compaction just replaced this thread's history, memory
// timeline included. PostCompact output cannot carry additionalContext, so the
// handler only marks the thread; src/shared/codex-compaction-gate.ts says which
// hook brings the timeline back.
import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { markTimelinePending } from '../../shared/codex-compaction-gate.js';

export const postCompactHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    markTimelinePending(input.sessionId, input.agentId);
    return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
  },
};
