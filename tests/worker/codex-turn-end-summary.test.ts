// What the worker does with the summary request a Codex Stop hook hands it.
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { ingestSummarize, type IngestContext } from '../../src/services/worker/http/shared.js';
import { handleGeneratorExit } from '../../src/services/worker/session/GeneratorExitHandler.js';
import { buildSummaryPrompt } from '../../src/sdk/prompts.js';
import { parseAgentXml } from '../../src/sdk/parser.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { HookSpool } from '../../src/shared/hook-spool.js';
import { LIVE_OBSERVER_MAX_AGE_MS } from '../../src/shared/observer-work-policy.js';
import { WAITING_FOR } from '../../src/services/work-view/waiting-for.mjs';
import { logger } from '../../src/utils/logger.js';
import { useTempHookSpoolDataDir } from '../helpers/temp-hook-spool.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';

const SESSION_ID = '01a1ce65-e816-7000-8000-000000000005';
const QUESTION = 'The cards are built. Shall I merge them?';

let store: SessionStore;
let manager: SessionManager;
let deps: IngestContext;
let sessionDbId: number;
let generatorStarts: string[];
let tempSpool: ReturnType<typeof useTempHookSpoolDataDir>;
let spies: ReturnType<typeof spyOn>[];

beforeEach(() => {
  tempSpool = useTempHookSpoolDataDir();
  spies = [
    spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => SettingsDefaultsManager.getAllDefaults()),
    ...(['info', 'debug', 'warn', 'error'] as const).map(level => spyOn(logger, level).mockImplementation(() => {})),
  ];
  store = new SessionStore(':memory:');
  const dbManager = {
    getSessionById: (id: number) => store.getSessionById(id),
    getSessionStore: () => store, getChromaSync: () => null, getCloudSync: () => null,
  } as unknown as DatabaseManager;
  manager = new SessionManager(dbManager);
  generatorStarts = [];
  deps = {
    sessionManager: manager, dbManager,
    eventBroadcaster: { broadcastSummarizeQueued: () => {} } as any,
    ensureGeneratorRunning: async (_id, source) => { generatorStarts.push(source); },
  };
  sessionDbId = store.createSDKSession(SESSION_ID, 'app', 'Please build the release cards', undefined, 'codex');
  store.saveUserPrompt(SESSION_ID, 1, 'Please build the release cards', sessionDbId);
});

afterEach(() => {
  manager.removeSessionImmediate(sessionDbId);
  store.close();
  spies.forEach(spy => spy.mockRestore());
  tempSpool.restore();
});

const turnEnds = (extra: Record<string, unknown> = {}) => ingestSummarize({
  contentSessionId: SESSION_ID, platformSource: 'codex', lastAssistantMessage: QUESTION, enqueuedAtEpochMs: Date.now(), ...extra,
}, deps);
const buffered = () => manager.getMessageBuffer().peekTypes(sessionDbId).map(message => message.message_type);
const stop = (reason: string) => handleGeneratorExit(manager.getSession(sessionDbId)!, reason, {
  sessionManager: manager,
  completionHandler: { finalizeSession: mock(() => Promise.resolve()) } as any,
  resumeGenerator: source => { generatorStarts.push(`resumed:${source}`); },
});

describe('a Codex turn end', () => {
  it('buffers one summary request and starts the observer once', async () => {
    expect(await turnEnds()).toEqual({ status: 'accepted' });

    expect(buffered()).toEqual(['summarize']);
    expect(generatorStarts).toEqual(['summarize']);
  });

  it('is asked what the turn waits for, in the words the board files a chat under, and the answer is kept', async () => {
    await turnEnds();
    const { value: request } = await manager.getMessageIterator(sessionDbId).next();
    const prompt = buildSummaryPrompt({
      id: sessionDbId, memory_session_id: 'memory-codex', project: 'app', user_prompt: 'Please build the release cards',
      last_assistant_message: request.last_assistant_message,
    }, ModeManager.getInstance().loadMode('code'));

    expect(prompt).toContain(QUESTION);
    const asked = /<waiting_for>\[([\s\S]*?)\]<\/waiting_for>/.exec(prompt)?.[1] ?? '';
    for (const word of WAITING_FOR) expect(asked).toContain(`${word} (`);

    const reply = parseAgentXml('<summary><request>Build the release cards</request><completed>Built them</completed><waiting_for>approval</waiting_for></summary>');
    store.updateMemorySessionId(sessionDbId, 'memory-codex');
    store.storeObservations('memory-codex', 'app', [], reply.summary!, 1, 0, Date.now());
    expect(store.db.query('SELECT waiting_for FROM session_summaries WHERE memory_session_id = ?').all('memory-codex'))
      .toEqual([{ waiting_for: 'approval' }]);
  });

  it('asks nothing for a chat no Codex hook registered, a subagent thread, or a turn end older than the live window', async () => {
    expect(await turnEnds({ contentSessionId: '01a1ce65-0000-7000-8000-000000000007' })).toEqual({ status: 'unknown_session' });
    expect(await turnEnds({ agentId: 'agent-1' })).toEqual({ status: 'skipped', reason: 'subagent_context' });
    expect(await turnEnds({ enqueuedAtEpochMs: Date.now() - LIVE_OBSERVER_MAX_AGE_MS })).toEqual({ status: 'skipped', reason: 'expired_live_capture' });

    expect(buffered()).toEqual([]);
    expect(generatorStarts).toEqual([]);
  });

  for (const reason of ['quota:usage limit reached, resets 14:00', 'auth:not logged in']) {
    it(`leaves nothing to send later when the observer stops for ${reason.split(':')[0]}`, async () => {
      await turnEnds();
      await stop(reason);

      expect(buffered()).toEqual([]);
      expect(new HookSpool().entries()).toEqual([]);
      expect(generatorStarts).toEqual(['summarize']);

      await turnEnds({ lastAssistantMessage: 'Merged. Anything else?' });
      const { value: next } = await manager.getMessageIterator(sessionDbId).next();
      expect(buffered()).toEqual(['summarize']);
      expect(next.last_assistant_message).toBe('Merged. Anything else?');
    });
  }
});
