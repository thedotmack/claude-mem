import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test';

// CLAUDE_MEM_DISABLE_SUMMARY (#4734) is checked inside the summarize handler,
// after Kimi's PreCompact marker clear: Kimi routes PreCompact through this
// same handler, and skipping the clear would stop Kimi re-injecting context
// after a compaction.
//
// bun's mock.module is process-global and sticky: snapshot each real module
// and re-register it in afterAll.
import * as realSpool from '../../../src/cli/spool-hook-event.js';
import * as realKimiGate from '../../../src/shared/kimi-context-gate.js';
import * as realHookSettings from '../../../src/shared/hook-settings.js';
import * as realRuntimeSelector from '../../../src/services/hooks/runtime-selector.js';
const realSpoolSnapshot = { ...realSpool };
const realKimiGateSnapshot = { ...realKimiGate };
const realHookSettingsSnapshot = { ...realHookSettings };
const realRuntimeSelectorSnapshot = { ...realRuntimeSelector };

const spooledEvents: string[] = [];
const clearedSessions: string[] = [];

mock.module('../../../src/cli/spool-hook-event.js', () => ({
  ...realSpoolSnapshot,
  spoolHookEvent: (event: string) => {
    spooledEvents.push(event);
  },
}));

mock.module('../../../src/shared/kimi-context-gate.js', () => ({
  ...realKimiGateSnapshot,
  clearInjected: (sessionId: string) => {
    clearedSessions.push(sessionId);
  },
}));

mock.module('../../../src/shared/hook-settings.js', () => ({
  ...realHookSettingsSnapshot,
  loadFromFileOnce: () => ({ CLAUDE_MEM_EXCLUDED_PROJECTS: '', CLAUDE_MEM_CAPTURE_ADVISOR_CALLS: 'false' }),
}));

mock.module('../../../src/services/hooks/runtime-selector.js', () => ({
  ...realRuntimeSelectorSnapshot,
  resolveRuntimeContext: () => ({ runtime: 'worker' }),
}));

afterAll(() => {
  mock.module('../../../src/cli/spool-hook-event.js', () => realSpoolSnapshot);
  mock.module('../../../src/shared/kimi-context-gate.js', () => realKimiGateSnapshot);
  mock.module('../../../src/shared/hook-settings.js', () => realHookSettingsSnapshot);
  mock.module('../../../src/services/hooks/runtime-selector.js', () => realRuntimeSelectorSnapshot);
});

const { summarizeHandler } = await import('../../../src/cli/handlers/summarize.js');

describe('summarizeHandler with CLAUDE_MEM_DISABLE_SUMMARY (#4734)', () => {
  const previous = process.env.CLAUDE_MEM_DISABLE_SUMMARY;

  beforeEach(() => {
    spooledEvents.length = 0;
    clearedSessions.length = 0;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.CLAUDE_MEM_DISABLE_SUMMARY;
    else process.env.CLAUDE_MEM_DISABLE_SUMMARY = previous;
  });

  it('skips the summary on a Claude Code Stop when the flag is set', async () => {
    process.env.CLAUDE_MEM_DISABLE_SUMMARY = '1';

    const result = await summarizeHandler.execute({
      sessionId: 'stop-disabled',
      cwd: process.cwd(),
      platform: 'claude-code',
      lastAssistantMessage: 'Done with the review.',
    });

    expect(result.continue).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(spooledEvents).toEqual([]);
  });

  it('still clears the Kimi injection marker on PreCompact when the flag is set', async () => {
    process.env.CLAUDE_MEM_DISABLE_SUMMARY = '1';

    const result = await summarizeHandler.execute({
      sessionId: 'kimi-precompact',
      cwd: process.cwd(),
      platform: 'kimi',
      hookEventName: 'PreCompact',
      lastAssistantMessage: 'Compacting now.',
    });

    expect(result.exitCode).toBe(0);
    expect(clearedSessions).toEqual(['kimi-precompact']);
    expect(spooledEvents).toEqual([]);
  });

  it('spools the summary as before when the flag is unset', async () => {
    delete process.env.CLAUDE_MEM_DISABLE_SUMMARY;

    await summarizeHandler.execute({
      sessionId: 'stop-enabled',
      cwd: process.cwd(),
      platform: 'claude-code',
      lastAssistantMessage: 'Done with the review.',
    });

    expect(spooledEvents).toEqual(['summarize']);
  });
});
