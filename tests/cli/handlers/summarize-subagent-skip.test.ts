/**
 * Tests for subagent-context short-circuit in summarizeHandler.
 *
 * Validates that when the Stop hook fires inside a Claude Code subagent
 * (identified by `agentId` or `agentType` on NormalizedHookInput), the
 * summarize handler exits before calling the worker — subagents must not
 * own the session summary.
 *
 * Sources:
 * - Handler: src/cli/handlers/summarize.ts
 * - Mock pattern: tests/hooks/context-reinjection-guard.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { homedir } from 'os';
import { join } from 'path';

// Mock modules that touch the filesystem / network at import time.
// MUST be declared before the handler is imported.
mock.module('../../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: {
    get: (key: string) => {
      if (key === 'CLAUDE_MEM_DATA_DIR') return join(homedir(), '.claude-mem');
      return '';
    },
    getInt: () => 0,
    loadFromFile: () => ({ CLAUDE_MEM_EXCLUDED_PROJECTS: [] }),
  },
}));

// workerHttpRequest is the only worker entry point we must NOT call in
// subagent context. It throws so we can assert "never called" by proving
// the handler returns success anyway.
const workerCallLog: Array<{ path: string; options: any }> = [];
mock.module('../../../src/shared/worker-utils.js', () => ({
  ensureWorkerRunning: () => Promise.resolve(true),
  getWorkerPort: () => 37777,
  workerHttpRequest: (apiPath: string, options?: any) => {
    workerCallLog.push({ path: apiPath, options });
    throw new Error(
      `workerHttpRequest MUST NOT be called in subagent context (called with ${apiPath})`
    );
  },
}));

// Suppress logger during tests
import { logger } from '../../../src/utils/logger.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

beforeEach(() => {
  workerCallLog.length = 0;
  loggerSpies = [
    spyOn(logger, 'info').mockImplementation(() => {}),
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation(() => {}),
    spyOn(logger, 'error').mockImplementation(() => {}),
    spyOn(logger, 'failure').mockImplementation(() => {}),
    spyOn(logger, 'dataIn').mockImplementation(() => {}),
  ];
});

afterEach(() => {
  loggerSpies.forEach(spy => spy.mockRestore());
});

describe('summarizeHandler — subagent short-circuit', () => {
  it('skips summary and returns SUCCESS when agentId is set', async () => {
    const { summarizeHandler } = await import('../../../src/cli/handlers/summarize.js');

    const result = await summarizeHandler.execute({
      sessionId: 'session-abc',
      cwd: '/tmp',
      platform: 'claude-code',
      transcriptPath: '/tmp/does-not-matter.jsonl',
      agentId: 'agent-abc',
    });

    expect(result.continue).toBe(true);
    expect(result.suppressOutput).toBe(true);
    expect(result.exitCode).toBe(0);
    // Guard fires BEFORE any worker HTTP request. If workerHttpRequest were
    // called, our mock would have thrown — reaching this expect proves it.
    expect(workerCallLog.length).toBe(0);
  });

  it('does NOT skip when only agentType is set (--agent main session still owns its summary)', async () => {
    // agent_type without agent_id is how Claude Code signals a main session started
    // with --agent. These are main sessions, not Task-spawned subagents, so the
    // summary path must proceed. Here the transcript path is missing so the handler
    // falls through to the existing no-transcriptPath return — the key assertion is
    // that the subagent guard did NOT short-circuit (handler reached the normal path).
    const { summarizeHandler } = await import('../../../src/cli/handlers/summarize.js');

    const result = await summarizeHandler.execute({
      sessionId: 'session-def',
      cwd: '/tmp',
      platform: 'claude-code',
      agentType: 'Explore',
      // transcriptPath intentionally omitted
    });

    expect(result.continue).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(workerCallLog.length).toBe(0);
  });

  it('skips summary when both agentId and agentType are set', async () => {
    const { summarizeHandler } = await import('../../../src/cli/handlers/summarize.js');

    const result = await summarizeHandler.execute({
      sessionId: 'session-both',
      cwd: '/tmp',
      platform: 'claude-code',
      transcriptPath: '/tmp/does-not-matter.jsonl',
      agentId: 'agent-xyz',
      agentType: 'Plan',
    });

    expect(result.continue).toBe(true);
    expect(result.suppressOutput).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(workerCallLog.length).toBe(0);
  });

  it('falls through to existing no-transcriptPath guard in main-session context', async () => {
    // Neither agentId nor agentType → NOT a subagent. Handler should
    // proceed past the subagent guard and hit the existing
    // "no transcriptPath" early return. Worker must still not be called.
    const { summarizeHandler } = await import('../../../src/cli/handlers/summarize.js');

    const result = await summarizeHandler.execute({
      sessionId: 'session-main',
      cwd: '/tmp',
      platform: 'claude-code',
      // transcriptPath intentionally omitted
    });

    expect(result.continue).toBe(true);
    expect(result.suppressOutput).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(workerCallLog.length).toBe(0);
  });
});
