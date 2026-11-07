import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { logger } from '../../src/utils/logger.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { SessionRoutes } from '../../src/services/worker/http/routes/SessionRoutes.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';

/**
 * #4963: tier routing picks the model when a generator starts, and the
 * generator keeps that model until it ends. A run started on the simple tier
 * must not go on to serve Bash/Edit/Write events that arrive later.
 */

function makeDbManager(): DatabaseManager {
  return {
    getSessionById: () => ({
      content_session_id: 'content-tier',
      project: 'proj',
      platform_source: 'claude',
      user_prompt: 'do the thing',
      memory_session_id: null,
    }),
    getSessionStore: () => ({
      getPromptNumberFromUserPrompts: () => 1,
    }),
    getChromaSync: () => undefined,
  } as unknown as DatabaseManager;
}

function queue(sm: SessionManager, sessionDbId: number, toolName: string, toolUseId: string): void {
  sm.queueObservation(sessionDbId, {
    tool_name: toolName,
    tool_input: {},
    tool_response: {},
    prompt_number: 1,
    toolUseId,
  });
}

let spies: ReturnType<typeof spyOn>[] = [];

describe('tier routing holds for the whole generator (#4963)', () => {
  beforeEach(() => {
    spies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    spies.forEach(s => s.mockRestore());
  });

  it('marks a run routed to the simple model, and only that run', async () => {
    const sm = new SessionManager(makeDbManager());
    const routes = new SessionRoutes(sm, {} as any, {} as any, {} as any, {} as any,
      {} as any, {} as any, {} as any);
    spies.push(spyOn(SettingsDefaultsManager, 'loadFromFile').mockReturnValue({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_TIER_ROUTING_ENABLED: 'true',
      CLAUDE_MEM_MODEL: 'claude-sonnet-4-6',
      CLAUDE_MEM_TIER_SIMPLE_MODEL: 'haiku',
    }));

    const simple = sm.initializeSession(51, 'do the thing', 1);
    queue(sm, 51, 'Read', 'tu-51-a');
    await (routes as any).applyTierRouting(simple);
    expect(simple.modelOverride).toBe('haiku');
    expect(simple.simpleTierRun).toBe(true);

    const mixed = sm.initializeSession(52, 'do the thing', 1);
    queue(sm, 52, 'Read', 'tu-52-a');
    queue(sm, 52, 'Bash', 'tu-52-b');
    mixed.simpleTierRun = true;
    await (routes as any).applyTierRouting(mixed);
    expect(mixed.modelOverride).toBeUndefined();
    expect(mixed.simpleTierRun).toBe(false);
  });

  it('ends a simple-tier run before it hands out a Bash event, keeping the queue', async () => {
    const sm = new SessionManager(makeDbManager());
    const session = sm.initializeSession(53, 'do the thing', 1);
    session.currentProvider = 'claude';
    session.simpleTierRun = true;
    queue(sm, 53, 'Read', 'tu-53-a');
    queue(sm, 53, 'Bash', 'tu-53-b');

    const iterator = sm.getMessageIterator(53);
    const first = await iterator.next();
    expect(first.value?.toolUseId).toBe('tu-53-a');
    await sm.confirmClaimedMessages(53);

    const second = await iterator.next();
    expect(second.done).toBe(true);
    expect(session.abortReason).toBe('provider_switch:boundary');
    expect(sm.getMessageBuffer().getPendingCount(53)).toBe(1);
  });

  it('keeps a simple-tier run going while only simple tools arrive', async () => {
    const sm = new SessionManager(makeDbManager());
    const session = sm.initializeSession(54, 'do the thing', 1);
    session.currentProvider = 'claude';
    session.simpleTierRun = true;
    queue(sm, 54, 'Read', 'tu-54-a');
    queue(sm, 54, 'Grep', 'tu-54-b');

    const iterator = sm.getMessageIterator(54);
    await iterator.next();
    await sm.confirmClaimedMessages(54);
    const second = await iterator.next();
    expect(second.done).toBe(false);
    expect(second.value?.toolUseId).toBe('tu-54-b');
    session.abortController.abort();
    await iterator.return?.(undefined);
  });

  it('does not batch a Bash event into a simple-tier request', () => {
    const sm = new SessionManager(makeDbManager());
    const session = sm.initializeSession(55, 'do the thing', 1);
    session.currentProvider = 'claude';
    session.simpleTierRun = true;
    queue(sm, 55, 'Bash', 'tu-55-a');

    expect(sm.claimNextObservation(55, () => true)).toBeNull();
    session.simpleTierRun = false;
    expect(sm.claimNextObservation(55, () => true)?.toolUseId).toBe('tu-55-a');
  });

  it('does not end the run in default settings, where the simple tier is the main model', async () => {
    // Defaults: CLAUDE_MEM_MODEL is a Haiku id and CLAUDE_MEM_TIER_SIMPLE_MODEL is
    // 'haiku'. Restarting the generator would only resend the prompt to the same model.
    const sm = new SessionManager(makeDbManager());
    const routes = new SessionRoutes(sm, {} as any, {} as any, {} as any, {} as any,
      {} as any, {} as any, {} as any);
    spies.push(spyOn(SettingsDefaultsManager, 'loadFromFile').mockReturnValue(
      SettingsDefaultsManager.getAllDefaults(),
    ));

    const session = sm.initializeSession(56, 'do the thing', 1);
    session.currentProvider = 'claude';
    queue(sm, 56, 'Read', 'tu-56-a');
    await (routes as any).applyTierRouting(session);
    expect(session.simpleTierRun).toBe(false);

    queue(sm, 56, 'Bash', 'tu-56-b');
    const iterator = sm.getMessageIterator(56);
    expect((await iterator.next()).value?.toolUseId).toBe('tu-56-a');
    await sm.confirmClaimedMessages(56);
    const second = await iterator.next();
    expect(second.done).toBe(false);
    expect(second.value?.toolUseId).toBe('tu-56-b');
    expect(session.abortReason).toBeUndefined();
    session.abortController.abort();
    await iterator.return?.(undefined);
  });

  it('ends a simple-tier run at a summarize, and the next run picks the summary tier', async () => {
    const sm = new SessionManager(makeDbManager());
    const routes = new SessionRoutes(sm, {} as any, {} as any, {} as any, {} as any,
      {} as any, {} as any, {} as any);
    const settings = {
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_TIER_ROUTING_ENABLED: 'true',
      CLAUDE_MEM_MODEL: 'claude-sonnet-4-6',
      CLAUDE_MEM_TIER_SIMPLE_MODEL: 'haiku',
      CLAUDE_MEM_TIER_SUMMARY_MODEL: 'opus',
    };
    const loadSettings = spyOn(SettingsDefaultsManager, 'loadFromFile').mockReturnValue(settings);
    spies.push(loadSettings);

    const session = sm.initializeSession(57, 'do the thing', 1);
    session.currentProvider = 'claude';
    queue(sm, 57, 'Read', 'tu-57-a');
    await (routes as any).applyTierRouting(session);
    expect(session.modelOverride).toBe('haiku');
    expect(session.simpleTierRun).toBe(true);

    sm.queueSummarize(57, 'done', 1);
    const iterator = sm.getMessageIterator(57);
    expect((await iterator.next()).value?.toolUseId).toBe('tu-57-a');
    await sm.confirmClaimedMessages(57);
    expect((await iterator.next()).done).toBe(true);
    expect(session.abortReason).toBe('provider_switch:boundary');
    expect(sm.getMessageBuffer().getPendingCount(57)).toBe(1);

    await (routes as any).applyTierRouting(session);
    expect(session.modelOverride).toBe('opus');
    expect(session.simpleTierRun).toBe(false);

    // With no summary model configured, the summary runs on CLAUDE_MEM_MODEL.
    loadSettings.mockReturnValue({ ...settings, CLAUDE_MEM_TIER_SUMMARY_MODEL: '' });
    await (routes as any).applyTierRouting(session);
    expect(session.modelOverride).toBeUndefined();
    expect(session.simpleTierRun).toBe(false);
  });
});
