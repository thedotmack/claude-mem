import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OpenAICompatProvider, resolveOpenAICompatConfig } from '../../src/services/worker/OpenAICompatProvider.js';
import { OpenRouterProvider } from '../../src/services/worker/OpenRouterProvider.js';
import { GeminiProvider } from '../../src/services/worker/GeminiProvider.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { buildObservationPromptParts, renderObservationPrompt } from '../../src/sdk/prompts.js';
import { observationFieldMaxChars } from '../../src/services/worker/context-window.js';
import { ClassifiedProviderError } from '../../src/services/worker/provider-errors.js';
import type { PendingMessage, PendingMessageWithId } from '../../src/services/worker-types.js';

const SETTING = 'CLAUDE_MEM_OPENAI_COMPAT_OBSERVATION_BATCH_SIZE';
const stores: SessionStore[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
const originalLoad = SettingsDefaultsManager.loadFromFile;
afterEach(() => {
  SettingsDefaultsManager.loadFromFile = originalLoad;
  mock.restore();
  for (const server of servers.splice(0)) server.stop(true);
  for (const store of stores.splice(0)) store.close();
});

function harness(count: unknown = '4', contextWindowTokens?: number) {
  ModeManager.getInstance().loadMode('code');
  const settings = { ...SettingsDefaultsManager.getAllDefaults(), [SETTING]: count,
    CLAUDE_MEM_PROVIDER: 'openai-compatible', CLAUDE_MEM_OPENAI_COMPAT_MODEL: 'batch-fixture',
    CLAUDE_MEM_OPENAI_COMPAT_PRESET: 'custom', CLAUDE_MEM_OPENAI_COMPAT_BASE_URL: 'http://127.0.0.1:1/v1',
    CLAUDE_MEM_OPENAI_COMPAT_API_KEY: '', CLAUDE_MEM_TIER_ROUTING_ENABLED: 'false',
    CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED: 'false',
  };
  SettingsDefaultsManager.loadFromFile = (() => settings) as typeof originalLoad;
  const store = new SessionStore(':memory:');
  stores.push(store);
  const sessionDbId = store.createSDKSession('batch-session', 'batch-project', 'inspect files');
  store.ensureMemorySessionIdRegistered(sessionDbId, 'batch-memory');
  const manager = new SessionManager(null as any);
  const session: any = { sessionDbId, contentSessionId: 'batch-session', memorySessionId: 'batch-memory',
    project: 'batch-project', platformSource: 'claude', abortController: new AbortController(),
    claimedMessageIds: [], earliestPendingTimestamp: null, conversationHistory: [], lastPromptNumber: 1,
    cumulativeInputTokens: 0, cumulativeOutputTokens: 0, observerContextWindowTokens: contextWindowTokens };
  (manager as any).sessions.set(sessionDbId, session);
  const buffer = manager.getMessageBuffer();
  const db = { getSessionStore: () => store, getChromaSync: () => null, getCloudSync: () => null };
  const provider: any = new OpenAICompatProvider(db as any, manager);
  provider.conversationMaxChars = () => 1_000_000;
  const enqueue = (overrides: Partial<PendingMessage> = {}, timestamp = 1_700_000_000_000) => buffer.enqueue(sessionDbId, {
    type: 'observation', tool_name: 'Read', tool_input: { file_path: 'file.ts' }, tool_response: 'file contents',
    prompt_number: 1, cwd: '/batch-project', ...overrides,
  }, timestamp);
  const first = () => manager.claimNextObservation(sessionDbId, () => true)!;
  const parts = (m: PendingMessageWithId) => buildObservationPromptParts({ id: m._persistentId,
    tool_name: m.tool_name!, tool_input: JSON.stringify(m.tool_input), tool_output: JSON.stringify(m.tool_response),
    created_at_epoch: m._originalTimestamp, cwd: m.cwd }, observationFieldMaxChars(contextWindowTokens));
  const render = (m: PendingMessageWithId) => provider.observationTurnPrompt(session, m, parts(m)) as string;
  const process = (m: PendingMessageWithId) => {
    session.pendingAgentId = m.agentId ?? null;
    session.pendingAgentType = m.agentType ?? null;
    return provider.processObservationMessage(session, m, undefined, resolveOpenAICompatConfig('unused'),
      m._originalTimestamp, m.cwd);
  };
  return { settings, manager, session, buffer, store, provider, enqueue, first, parts, render, process };
}

describe('OpenAI-compatible observation batching (#4967)', () => {
  it('defaults to 1, reads settings.json, and lets the environment override it', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'claude-mem-openai-batch-'));
    const settingsPath = path.join(directory, 'settings.json');
    const saved = process.env[SETTING];
    try {
      delete process.env[SETTING];
      expect(SettingsDefaultsManager.getAllDefaults()[SETTING]).toBe('1');
      writeFileSync(settingsPath, JSON.stringify({ [SETTING]: '3' }));
      expect(SettingsDefaultsManager.loadFromFile(settingsPath)[SETTING]).toBe('3');
      process.env[SETTING] = '2';
      expect(SettingsDefaultsManager.loadFromFile(settingsPath)[SETTING]).toBe('2');
    } finally {
      if (saved === undefined) delete process.env[SETTING];
      else process.env[SETTING] = saved;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('claims only the configured number in FIFO order, retaining event timestamps', () => {
    const h = harness('2');
    const ids = Array.from({ length: 3 }, (_, i) => h.enqueue({ tool_response: `event-${i}` }, 1_700_000_000_000 + i * 1000));
    const prompt = h.render(h.first());
    expect(h.session.claimedMessageIds).toEqual(ids.slice(0, 2));
    expect(prompt.indexOf('event-0')).toBeLessThan(prompt.indexOf('event-1'));
    expect(prompt).not.toContain('event-2');
    expect(prompt).toContain('2023-11-14T22:13:21.000Z');
  });

  for (const count of [undefined, '1', '0', '-1', '1.5', '33', 'invalid']) {
    it(`preserves the original single-event prompt for batch size ${count}`, () => {
      const h = harness(count);
      // Explicit undefined exercises an absent setting, not harness's default.
      h.settings[SETTING] = count;
      h.enqueue(); h.enqueue();
      const first = h.first();
      expect(h.render(first)).toBe(renderObservationPrompt(h.parts(first)));
      expect(h.session.claimedMessageIds).toEqual([first._persistentId]);
    });
  }

  it('does not wait to fill a batch or take work from another session', () => {
    const h = harness(); const id = h.enqueue();
    h.buffer.enqueue(2, { type: 'observation', tool_name: 'Read', tool_response: 'another session' });
    expect(h.render(h.first())).not.toContain('another session');
    expect(h.session.claimedMessageIds).toEqual([id]);
    expect(h.buffer.getPendingCount(2)).toBe(1);
  });

  for (const Provider of [OpenRouterProvider, GeminiProvider]) {
    it(`does not enable batching in ${Provider.name}`, () => {
      const h = harness(); h.enqueue(); h.enqueue();
      const first = h.first();
      const provider = new Provider({} as any, h.manager) as any;
      expect(provider.observationTurnPrompt(h.session, first, h.parts(first))).toBe(renderObservationPrompt(h.parts(first)));
      expect(h.session.claimedMessageIds).toEqual([first._persistentId]);
    });
  }

  for (const barrier of [{ type: 'summarize' }, { prompt_number: 2 }, { agentId: 'other' },
    { agentType: 'other' }, { cwd: '/other-project' }]) {
    it(`does not cross or skip the FIFO barrier ${JSON.stringify(barrier)}`, () => {
      const h = harness(); const id = h.enqueue();
      h.enqueue(barrier as Partial<PendingMessage>); h.enqueue();
      h.render(h.first());
      expect(h.session.claimedMessageIds).toEqual([id]);
      expect(h.buffer.getPendingCount(h.session.sessionDbId)).toBe(3);
    });
  }

  it('ends the batch at the model-window character budget', () => {
    const h = harness('32', 10_000);
    const ids = Array.from({ length: 4 }, () => h.enqueue({ tool_response: 'x'.repeat(2200) }));
    const prompt = h.render(h.first());
    expect(prompt.length).toBeLessThanOrEqual(2 * observationFieldMaxChars(10_000));
    expect(h.session.claimedMessageIds).toEqual(ids.slice(0, 2));
  });

  for (const field of ['tool_input', 'tool_response'] as const) {
    it(`leaves a large ${field} queued for its own condensation pass`, () => {
      const h = harness('4', 10_000); const id = h.enqueue();
      h.enqueue({ [field]: 'x'.repeat(observationFieldMaxChars(10_000) + 1) }); h.enqueue();
      h.render(h.first());
      expect(h.session.claimedMessageIds).toEqual([id]);
    });
  }

  it('does not truncate a first event whose wrapper exceeds the batching budget', () => {
    const h = harness('4', 10_000); h.enqueue({ cwd: 'long-directory/'.repeat(1000) }); h.enqueue();
    const first = h.first();
    expect(h.render(first)).toBe(renderObservationPrompt(h.parts(first)));
    expect(h.session.claimedMessageIds).toEqual([first._persistentId]);
  });

  it('confirms exactly the included batch after an accepted skip', async () => {
    const h = harness('2'); const ids = [h.enqueue(), h.enqueue(), h.enqueue()];
    h.provider.query = async () => ({ content: '<skip_summary reason="noise" />' });
    await h.process(h.first());
    expect(h.buffer.getMessagesByIds(h.session.sessionDbId, ids).map(m => m._persistentId)).toEqual([ids[2]]);
    expect(h.session.claimedMessageIds).toEqual([]);
  });

  for (const kind of ['transient', 'quota_exhausted'] as const) {
    it(`keeps the entire batch on ${kind} and restores FIFO when released`, async () => {
      const h = harness('2'); const ids = [h.enqueue(), h.enqueue(), h.enqueue()];
      h.provider.query = async () => { throw new ClassifiedProviderError('fixture failure', { kind, cause: null }); };
      await expect(h.process(h.first())).rejects.toThrow('fixture failure');
      expect(h.session.claimedMessageIds).toEqual(ids.slice(0, 2));
      expect(h.buffer.getPendingCount(h.session.sessionDbId)).toBe(3);
      await h.manager.resetProcessingToPending(h.session.sessionDbId);
      expect(h.first()._persistentId).toBe(ids[0]);
    });
  }

  it('retains rejected output as one batch rather than confirming its events', async () => {
    const h = harness('2'); const ids = [h.enqueue(), h.enqueue(), h.enqueue()];
    h.provider.query = async () => ({ content: 'Skipping' });
    await h.process(h.first());
    expect(h.session.abortReason).toBe('output_retry:prose');
    expect(h.session.claimedMessageIds).toEqual([]);
    expect(h.buffer.getPendingCount(h.session.sessionDbId)).toBe(3);
    expect(h.buffer.claimNextMatching(h.session.sessionDbId, () => true)?._persistentId).toBe(ids[0]);
  });

  it('does not store or confirm a response arriving after cancellation', async () => {
    const h = harness(); h.enqueue(); h.enqueue();
    const storeSpy = spyOn(h.store, 'storeObservations');
    h.provider.query = async () => {
      h.session.abortController.abort();
      return { content: '<skip_summary reason="noise" />' };
    };
    await expect(h.process(h.first())).rejects.toThrow();
    expect(storeSpy).not.toHaveBeenCalled();
    expect(h.buffer.getPendingCount(h.session.sessionDbId)).toBe(2);
  });

  it('keeps the existing single retry when a rejected batch grows', async () => {
    const h = harness(); h.enqueue();
    h.provider.query = async () => ({ content: 'Skipping' });
    await h.process(h.first());
    expect(h.session.abortReason).toBe('output_retry:prose');
    h.enqueue();
    h.session.abortController = new AbortController();
    h.session.abortReason = undefined;
    await h.process(h.first());
    expect(h.session.abortReason).toBeUndefined();
    expect(h.buffer.getPendingCount(h.session.sessionDbId)).toBe(0);
  });

  it('does not send or claim more work after cancellation before the request', async () => {
    const h = harness(); const id = h.enqueue(); h.enqueue();
    const first = h.first(); h.session.abortController.abort();
    h.provider.query = mock(async () => ({ content: '<skip_summary reason="noise" />' }));
    await expect(h.process(first)).rejects.toThrow();
    expect(h.provider.query).not.toHaveBeenCalled();
    expect(h.session.claimedMessageIds).toEqual([id]);
  });

  it('preserves queued work when the conversation recycles before sending', async () => {
    const h = harness(); const id = h.enqueue(); h.enqueue();
    h.provider.conversationMaxChars = () => 1;
    h.session.conversationHistory = [{ role: 'user', content: 'full' }];
    h.provider.query = mock(async () => { throw new Error('must not send'); });
    await h.process(h.first());
    expect(h.provider.query).not.toHaveBeenCalled();
    expect(h.session.claimedMessageIds).toEqual([]);
    expect(h.buffer.claimNextMatching(h.session.sessionDbId, () => true)?._persistentId).toBe(id);
  });

  it('stores the same eight fixture observations with 2 HTTP requests instead of 8', async () => {
    const runs: Array<{ requests: number; titles: string[] }> = [];
    for (const size of ['1', '4']) {
      const h = harness(size);
      const requests: number[][] = [];
      const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
        const body = await request.json() as { messages: Array<{ role: string; content: string }> };
        const lastTurn = body.messages.at(-1)!.content;
        const events = [...lastTurn.matchAll(/batch-event-(\d+)/g)].map(match => Number(match[1]));
        requests.push(events);
        const content = events.map(id => `<observation><type>discovery</type><title>event-${id}</title>
          <narrative>Fixture finding ${id}</narrative><facts><fact>Finding ${id}</fact></facts>
          <concepts><concept>how-it-works</concept></concepts></observation>`).join('\n');
        return Response.json({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
      } });
      servers.push(server);
      h.settings.CLAUDE_MEM_OPENAI_COMPAT_BASE_URL = `http://127.0.0.1:${server.port}/v1`;
      for (let i = 0; i < 8; i++) h.enqueue({ tool_input: { file_path: `src/file-${i}.ts` }, tool_response: `batch-event-${i}` });
      while (h.buffer.getPendingCount(h.session.sessionDbId) > 0) await h.process(h.first());
      expect(requests.flat()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
      const rows = h.store.db.prepare('SELECT title, project, prompt_number, files_read FROM observations ORDER BY id')
        .all() as Array<{ title: string; project: string; prompt_number: number; files_read: string }>;
      expect(rows).toHaveLength(8);
      expect(rows.every(row => row.project === 'batch-project' && row.prompt_number === 1)).toBe(true);
      expect(new Set(rows.flatMap(row => JSON.parse(row.files_read)))).toEqual(new Set(Array.from({ length: 8 }, (_, i) => `src/file-${i}.ts`)));
      runs.push({ requests: requests.length, titles: rows.map(row => row.title) });
    }
    expect(runs[0].requests).toBe(8);
    expect(runs[1].requests).toBe(2);
    expect(runs[1].titles).toEqual(runs[0].titles);
  });
});
