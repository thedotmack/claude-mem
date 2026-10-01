// The transcript watcher anchors each turn through recordSessionPrompt (#3653).
// Unlike the fail-open hook handler, it must report a prompt the worker did not
// record, or the watcher checkpoints past a turn that was never anchored (R5-2).
import { afterEach, describe, expect, it } from 'bun:test';
import {
  recordSessionPrompt,
  sessionInitHandler,
  SessionPromptNotRecordedError,
  setSessionInitDependenciesForTesting,
} from '../../../src/cli/handlers/session-init.js';
import type { SettingsDefaults } from '../../../src/shared/SettingsDefaultsManager.js';

const turn = {
  sessionId: 'transcript-session',
  cwd: '/tmp/session-init-record-prompt',
  platform: 'codex',
  prompt: 'a transcript turn that must be anchored',
};

/** The worker answers every init call with `reply`; `fallback` marks it as executeWithWorkerFallback's fallback. */
function useWorkerReply(reply: unknown, fallback: boolean): void {
  setSessionInitDependenciesForTesting({
    loadFromFileOnce: () => ({ CLAUDE_MEM_SEMANTIC_INJECT: 'false' }) as unknown as SettingsDefaults,
    resolveRuntimeContext: () => ({ runtime: 'worker' }),
    shouldTrackProject: () => true,
    getSessionInitRequestTimeoutMs: () => 10_000,
    executeWithWorkerFallback: async () => reply as never,
    isWorkerFallback: () => fallback,
    consumeWorkerOutageNotice: async () => null,
  });
}

describe('recordSessionPrompt (the transcript anchor)', () => {
  afterEach(() => {
    setSessionInitDependenciesForTesting();
  });

  for (const reason of ['worker_unreachable', 'worker_api_503', 'worker_api_429']) {
    it(`throws when the worker call fell back (${reason}); the hook handler stays fail-open`, async () => {
      useWorkerReply({ continue: true, reason }, true);

      const failure = await recordSessionPrompt(turn).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(SessionPromptNotRecordedError);
      expect((failure as SessionPromptNotRecordedError).reason).toBe(reason);

      const hookResult = await sessionInitHandler.execute(turn);
      expect(hookResult.continue).toBe(true);
    });
  }

  it('throws on a reply with no session id', async () => {
    useWorkerReply({ unexpected: true }, false);
    await expect(recordSessionPrompt(turn)).rejects.toBeInstanceOf(SessionPromptNotRecordedError);
  });

  it('returns normally once the prompt is recorded', async () => {
    useWorkerReply({ sessionDbId: 7, promptNumber: 1 }, false);
    await expect(recordSessionPrompt(turn)).resolves.toMatchObject({ continue: true });
  });

  it('treats a deliberate skip as a skip, not a failure', async () => {
    useWorkerReply({ skipped: true, reason: 'project_excluded' }, false);
    await expect(recordSessionPrompt(turn)).resolves.toMatchObject({ continue: true });

    useWorkerReply({ sessionDbId: 7, promptNumber: 1, skipped: true, reason: 'private' }, false);
    await expect(recordSessionPrompt(turn)).resolves.toMatchObject({ continue: true });
  });
});
