import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { installScriptedClaudeSdk, createScriptedSession } from '../fixtures/worker/scripted-claude-sdk.js';
import type { ActiveSession } from '../../src/services/worker-types.js';
import { ClassifiedProviderError } from '../../src/services/worker/provider-errors.js';
import {
  OBSERVER_DIR_UNUSABLE_CODE,
  clearDependencyStatus,
  getDependencyStatus,
} from '../../src/shared/dependency-health.js';

/**
 * When the agent SDK spawns the resolved executable itself (the standalone
 * observer calls pass no cmd.exe wrapper), a missing binary (ENOENT) or a
 * Windows .cmd/.bat shim it cannot launch (EINVAL) is thrown from the query
 * loop. startSession must run that raw spawn error through classifyClaudeError
 * so a setup failure surfaces as `setup_required` instead of reaching
 * SessionRoutes unclassified and being retried on every later observation.
 *
 * bun's mock.module is process-global and sticky: snapshot each real module
 * and restore it in afterAll so these stubs never leak into later suites.
 */
const sdkFixture = installScriptedClaudeSdk({ executable: '/mock/codex.cmd' });
afterAll(() => sdkFixture.restore());
const { ClaudeProvider } = await import('../../src/services/worker/ClaudeProvider.js');

function createSession(): ActiveSession {
  return createScriptedSession(7788, { modelOverride: 'claude-sonnet-test' });
}

function createProvider() {
  const sessionManager = {
    getMessageIterator: async function* () {},
    resetProcessingToPending: async () => 0,
    confirmClaimedMessages: async () => 0,
  };
  const dbManager = {
    getSessionStore: () => ({ ensureMemorySessionIdRegistered: () => {} }),
  };
  return new ClaudeProvider(dbManager as never, sessionManager as never);
}

describe('ClaudeProvider startSession spawn-error classification', () => {
  beforeEach(() => {
    sdkFixture.messages = [];
    clearDependencyStatus('claude_cli');
  });

  it.each([
    ['a Windows .cmd shim EINVAL', Object.assign(new Error('spawn /mock/codex.cmd EINVAL'), { code: 'EINVAL' })],
    ['an ENOENT', Object.assign(new Error("spawn 'codex' ENOENT"), { code: 'ENOENT' })],
    ['an EINVAL with syscall', Object.assign(new Error('spawn /mock/codex.cmd EINVAL'), { code: 'EINVAL', syscall: 'spawn /mock/codex.cmd' })],
  ])('classifies %s from SDK spawn as setup_required with its executable', async (_label, error) => {
    sdkFixture.messages = [{ throwError: error }];
    const run = createProvider().startSession(createSession());
    await expect(run).rejects.toBeInstanceOf(ClassifiedProviderError);
    await expect(run).rejects.toMatchObject({
      kind: 'setup_required', executablePath: '/mock/codex.cmd',
    });
    const status = getDependencyStatus('claude_cli');
    expect(status?.executablePath).toBe('/mock/codex.cmd');
    expect(status?.executableFingerprint).toBeDefined();
    expect(status?.remediation).toContain('CLAUDE_MEM_PROVIDER to codex');
  });

  it('rethrows an already-classified error untouched (an observer-dir failure keeps its code)', async () => {
    const observerDir = new ClassifiedProviderError('ENOENT: cannot create the observer directory', {
      kind: 'setup_required', cause: null, code: OBSERVER_DIR_UNUSABLE_CODE,
    });
    sdkFixture.messages = [{ throwError: observerDir }];
    await expect(createProvider().startSession(createSession())).rejects.toBe(observerDir);
  });

  it.each([
    ['a file-read ENOENT', Object.assign(new Error("ENOENT: no such file or directory, open 'missing-file'"), { code: 'ENOENT', syscall: 'open' })],
    ['a non-setup failure', new Error('ECONNRESET: socket hang up')],
  ])('leaves %s unclassified', async (_label, error) => {
    sdkFixture.messages = [{ throwError: error }];
    await expect(createProvider().startSession(createSession())).rejects.toBe(error);
  });
});
