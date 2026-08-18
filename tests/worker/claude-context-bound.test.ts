import { describe, expect, it, mock } from 'bun:test';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { handleGeneratorExit } from '../../src/services/worker/session/GeneratorExitHandler.js';
import { SettingsRoutes } from '../../src/services/worker/http/routes/SettingsRoutes.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import {
  DEFAULT_CLAUDE_MAX_TOKENS,
  requestClaudeContextRollover,
  resolveClaudeMaxTokens,
} from '../../src/services/worker/ClaudeProvider.js';

function makeDbManager(): DatabaseManager {
  return {
    getSessionById: () => ({
      content_session_id: 'content-123',
      project: 'project',
      platform_source: 'claude',
      user_prompt: 'prompt',
      memory_session_id: null,
    }),
    getSessionStore: () => ({
      getPromptNumberFromUserPrompts: () => 1,
    }),
  } as unknown as DatabaseManager;
}

describe('Claude observer context rollover', () => {
  it('defaults to a proactive 150k-token threshold', () => {
    expect(DEFAULT_CLAUDE_MAX_TOKENS).toBe(150_000);
    expect(SettingsDefaultsManager.getAllDefaults().CLAUDE_MEM_CLAUDE_MAX_TOKENS).toBe('150000');
  });

  it('accepts a valid configured threshold and rejects unsafe runtime values', () => {
    expect(resolveClaudeMaxTokens('180000')).toBe(180_000);
    expect(resolveClaudeMaxTokens(undefined)).toBe(DEFAULT_CLAUDE_MAX_TOKENS);
    expect(resolveClaudeMaxTokens('')).toBe(DEFAULT_CLAUDE_MAX_TOKENS);
    expect(resolveClaudeMaxTokens('150000junk')).toBe(DEFAULT_CLAUDE_MAX_TOKENS);
    expect(resolveClaudeMaxTokens('999')).toBe(DEFAULT_CLAUDE_MAX_TOKENS);
    expect(resolveClaudeMaxTokens('1000001')).toBe(DEFAULT_CLAUDE_MAX_TOKENS);
  });

  it('rejects invalid persisted thresholds at the settings API boundary', () => {
    const routes = new SettingsRoutes({} as never);
    const validateSettings = (routes as unknown as {
      validateSettings: (settings: Record<string, unknown>) => { valid: boolean; error?: string };
    }).validateSettings.bind(routes);

    expect(validateSettings({ CLAUDE_MEM_CLAUDE_MAX_TOKENS: '150000' })).toEqual({ valid: true });
    expect(validateSettings({ CLAUDE_MEM_CLAUDE_MAX_TOKENS: '150000junk' })).toMatchObject({ valid: false });
    expect(validateSettings({ CLAUDE_MEM_CLAUDE_MAX_TOKENS: '999' })).toMatchObject({ valid: false });
    expect(validateSettings({ CLAUDE_MEM_CLAUDE_MAX_TOKENS: '1000001' })).toMatchObject({ valid: false });
    expect(validateSettings({ CLAUDE_MEM_CLAUDE_MAX_TOKENS: 150000 })).toMatchObject({ valid: false });
  });

  it('uses finalized full-context usage and rolls over at the configured threshold', () => {
    const below = {
      abortController: new AbortController(),
      abortReason: null,
    };
    const atLimit = {
      abortController: new AbortController(),
      abortReason: null,
    };

    expect(requestClaudeContextRollover(below, {
      input_tokens: 1_000,
      cache_creation_input_tokens: 2_000,
      cache_read_input_tokens: 146_999,
    }, 150_000)).toBeNull();
    expect(below.abortController.signal.aborted).toBe(false);

    expect(requestClaudeContextRollover(atLimit, {
      input_tokens: 1_000,
      cache_creation_input_tokens: 2_000,
      cache_read_input_tokens: 147_000,
    }, 150_000)).toBe(150_000);
    expect(atLimit.abortReason).toBe('context-bound');
    expect(atLimit.abortController.signal.aborted).toBe(true);
  });

  it('does not roll over when finalized usage is missing or malformed', () => {
    const session = {
      abortController: new AbortController(),
      abortReason: null,
    };

    expect(requestClaudeContextRollover(session, undefined, 150_000)).toBeNull();
    expect(requestClaudeContextRollover(session, {
      input_tokens: Number.NaN,
      cache_creation_input_tokens: -1,
      cache_read_input_tokens: Number.POSITIVE_INFINITY,
    }, 150_000)).toBeNull();
    expect(session.abortController.signal.aborted).toBe(false);
  });

  it('does not roll over on the synthetic init turn', () => {
    const session = {
      abortController: new AbortController(),
      abortReason: null,
    };

    expect(requestClaudeContextRollover(session, {
      input_tokens: 150_000,
    }, 150_000, 'init')).toBeNull();
    expect(session.abortController.signal.aborted).toBe(false);
  });

  it('clears the replacement-start retry budget after a finalized real turn', () => {
    const session = {
      abortController: new AbortController(),
      abortReason: null,
      contextRolloverRestartAttempts: 2,
    };

    expect(requestClaudeContextRollover(session, {
      input_tokens: 1_000,
    }, 150_000, 'ingest')).toBeNull();
    expect(session.contextRolloverRestartAttempts).toBe(0);
  });

  it('preserves queued work and immediately restarts after a context rollover', async () => {
    const sessionManager = new SessionManager(makeDbManager());
    const session = sessionManager.initializeSession(1, 'prompt', 1);
    session.currentProvider = 'claude';
    session.generatorPromise = Promise.resolve();
    await sessionManager.queueObservation(1, {
      tool_name: 'Read',
      tool_input: {},
      tool_response: { durable: 'queued behind the saved turn' },
      prompt_number: 1,
      toolUseId: 'rollover-pending',
    });

    const finalizeSession = mock(() => Promise.resolve());
    const restartGenerator = mock(async () => {
      // The exiting promise must release ownership before the replacement is
      // started, otherwise ensureGeneratorRunning would see a false in-flight
      // generator and leave the queued item stranded.
      expect(session.generatorPromise).toBeNull();
      expect(session.currentProvider).toBeNull();
      session.generatorPromise = Promise.resolve();
      session.currentProvider = 'claude';
    });
    await handleGeneratorExit(session, 'context-bound', {
      sessionManager,
      completionHandler: { finalizeSession } as never,
      restartGenerator,
    });

    expect(finalizeSession).not.toHaveBeenCalled();
    expect(restartGenerator).toHaveBeenCalledTimes(1);
    expect(restartGenerator).toHaveBeenCalledWith(1, 'context-bound');
    expect(sessionManager.getSession(1)).toBe(session);
    expect(sessionManager.getMessageBuffer().getPendingCount(1)).toBe(1);
    expect(session.generatorPromise).not.toBeNull();
    expect(session.currentProvider).toBe('claude');
  });

  it('does not start an empty replacement generator after a context rollover', async () => {
    const sessionManager = new SessionManager(makeDbManager());
    const session = sessionManager.initializeSession(3, 'prompt', 1);
    session.currentProvider = 'claude';
    session.generatorPromise = Promise.resolve();
    const restartGenerator = mock(() => Promise.resolve());

    await handleGeneratorExit(session, 'context-bound', {
      sessionManager,
      completionHandler: { finalizeSession: mock(() => Promise.resolve()) } as never,
      restartGenerator,
    });

    expect(restartGenerator).not.toHaveBeenCalled();
    expect(sessionManager.getSession(3)).toBe(session);
  });

  it('retries a rejected replacement start and hands queued work to the successful start', async () => {
    const sessionManager = new SessionManager(makeDbManager());
    const session = sessionManager.initializeSession(4, 'prompt', 1);
    session.currentProvider = 'claude';
    session.generatorPromise = Promise.resolve();
    await sessionManager.queueObservation(4, {
      tool_name: 'Read',
      tool_input: {},
      tool_response: { durable: 'retry me' },
      prompt_number: 1,
      toolUseId: 'rollover-retry-once',
    });

    let attempt = 0;
    const restartGenerator = mock(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('transient replacement failure');
      session.generatorPromise = Promise.resolve();
      session.currentProvider = 'claude';
    });
    const finalizeSession = mock(() => Promise.resolve());

    await handleGeneratorExit(session, 'context-bound', {
      sessionManager,
      completionHandler: { finalizeSession } as never,
      restartGenerator,
    });

    expect(restartGenerator).toHaveBeenCalledTimes(2);
    expect(finalizeSession).not.toHaveBeenCalled();
    expect(sessionManager.getMessageBuffer().getPendingCount(4)).toBe(1);
    expect(session.generatorPromise).not.toBeNull();
  });

  it('bounds persistent replacement failures without deleting queued work', async () => {
    const sessionManager = new SessionManager(makeDbManager());
    const session = sessionManager.initializeSession(5, 'prompt', 1);
    session.currentProvider = 'claude';
    session.generatorPromise = Promise.resolve();
    await sessionManager.queueObservation(5, {
      tool_name: 'Read',
      tool_input: {},
      tool_response: { durable: 'never delete me' },
      prompt_number: 1,
      toolUseId: 'rollover-retry-bounded',
    });

    const restartGenerator = mock(async () => {
      throw new Error('persistent replacement failure');
    });
    const finalizeSession = mock(() => Promise.resolve());

    await handleGeneratorExit(session, 'context-bound', {
      sessionManager,
      completionHandler: { finalizeSession } as never,
      restartGenerator,
    });

    expect(restartGenerator).toHaveBeenCalledTimes(3);
    expect(finalizeSession).not.toHaveBeenCalled();
    expect(sessionManager.getSession(5)).toBe(session);
    expect(sessionManager.getMessageBuffer().getPendingCount(5)).toBe(1);
    expect(session.generatorPromise).toBeNull();
    expect(session.currentProvider).toBeNull();
  });

  it('still finalizes ordinary idle exits so the preservation rule cannot leak sessions', async () => {
    const sessionManager = new SessionManager(makeDbManager());
    const session = sessionManager.initializeSession(2, 'prompt', 1);
    session.currentProvider = 'claude';
    session.generatorPromise = Promise.resolve();
    const finalizeSession = mock(() => Promise.resolve());

    await handleGeneratorExit(session, 'idle', {
      sessionManager,
      completionHandler: { finalizeSession } as never,
    });

    expect(finalizeSession).toHaveBeenCalledWith(2);
    expect(sessionManager.getSession(2)).toBeUndefined();
  });
});
