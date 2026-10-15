// IO discipline (see src/shared/hook-io.ts): this handler is PURE. It returns a
// HookResult and MUST NOT call process.stderr.write / process.stdout.write /
// console.* / process.exit.
//
// Codex SubagentStart: Codex starts a spawned subagent with SubagentStart,
// never SessionStart, so this is the only hook that can give a subagent its
// memory timeline when it starts. A forked subagent starts from a copy of its
// parent's history, timeline included, so only a subagent that starts with an
// empty history gets the timeline here.
import { closeSync, openSync, readSync } from 'fs';
import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { logger } from '../../utils/logger.js';
import { contextHandler } from './context.js';

// A Codex rollout's first line is its session_meta record, about 20 KB because
// it carries the base instructions.
const SESSION_META_MAX_BYTES = 1024 * 1024;

/**
 * True when the thread's rollout says it was forked from another thread's
 * history (session_meta payload.forked_from_id). Codex writes the rollout
 * before it runs a hook that is given its path. An unreadable rollout counts as
 * not forked: a duplicate timeline costs tokens, a missing one costs the memory.
 */
function isForkedThread(transcriptPath: string | undefined): boolean {
  if (!transcriptPath) return false;
  try {
    const fileDescriptor = openSync(transcriptPath, 'r');
    try {
      const buffer = Buffer.alloc(SESSION_META_MAX_BYTES);
      const bytesRead = readSync(fileDescriptor, buffer, 0, buffer.length, 0);
      const text = buffer.toString('utf8', 0, bytesRead);
      const newline = text.indexOf('\n');
      const sessionMeta = JSON.parse(newline < 0 ? text : text.slice(0, newline));
      return sessionMeta?.type === 'session_meta' && typeof sessionMeta.payload?.forked_from_id === 'string';
    } finally {
      closeSync(fileDescriptor);
    }
  } catch (error: unknown) {
    logger.debug('HOOK', 'SubagentStart: could not read the subagent rollout, treating it as a fresh subagent', {
      transcriptPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export const subagentContextHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    if (isForkedThread(input.transcriptPath)) {
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }
    // Codex records even an empty additionalContext as a message, so none is
    // sent without a timeline. The rest (the worker-outage notice) goes either way.
    const { hookSpecificOutput, ...contextResultWithoutContext } = await contextHandler.execute(input);
    const timeline = hookSpecificOutput?.additionalContext;
    if (!timeline) return contextResultWithoutContext;
    return {
      ...contextResultWithoutContext,
      hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: timeline },
    };
  },
};
