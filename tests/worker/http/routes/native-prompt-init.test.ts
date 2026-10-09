import { describe, expect, it, setSystemTime } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { SessionRoutes } from '../../../../src/services/worker/http/routes/SessionRoutes.js';
import { SessionManager } from '../../../../src/services/worker/SessionManager.js';
import { setIngestContext } from '../../../../src/services/worker/http/shared.js';

async function createRealSessionFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'cmem-native-http-'));
  const store = new SessionStore(join(dir, 'sessions.sqlite'), { syncOpsEnabled: false });
  const dbManager = {
    getSessionStore: () => store,
    getSessionById: (id: number) => {
      const row = store.getSessionById(id);
      if (!row) throw new Error('Fixture session missing');
      return row;
    },
    getCloudSync: () => undefined,
    getChromaSync: () => undefined,
  };
  const manager = new SessionManager(dbManager as any);
  const starts: { source: string; promptNumber?: number; userPrompt?: string }[] = [];
  const broadcaster = {
    broadcastNewPrompt() {}, broadcastSessionStarted() {},
    broadcastObservationQueued() {}, broadcastSummarizeQueued() {},
  };
  const routes = new SessionRoutes(manager, dbManager as any,
    {} as any, {} as any, {} as any, broadcaster as any, {} as any, {} as any);
  routes.ensureGeneratorRunning = async (id, source) => {
    const session = manager.getSession(id);
    starts.push({ source, promptNumber: session?.lastPromptNumber, userPrompt: session?.userPrompt });
  };
  setIngestContext({
    sessionManager: manager, dbManager: dbManager as any, eventBroadcaster: broadcaster as any,
    ensureGeneratorRunning: (id, source) => routes.ensureGeneratorRunning(id, source),
  });
  const app = express(); app.use(express.json()); routes.setupRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address() as { port: number };
  const post = async (route: string, body: object) => {
    const response = await fetch('http://127.0.0.1:' + address.port + '/api/sessions/' + route, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const init = (nativePromptId: string, prompt: string) => post('init', {
    contentSessionId: 'recovery-session', project: 'fixture', platformSource: 'hermes', nativePromptId, prompt,
  });
  const observe = (toolUseId: string) => post('observations', {
    contentSessionId: 'recovery-session', platformSource: 'hermes', tool_name: 'Read',
    tool_input: { file_path: join(dir, 'fixture.txt') }, tool_response: 'fixture marker', cwd: dir, tool_use_id: toolUseId,
  });
  const summarize = () => post('summarize', {
    contentSessionId: 'recovery-session', platformSource: 'hermes', last_assistant_message: 'Real second-turn summary', cwd: dir,
  });
  return {
    store, manager, starts, init, observe, summarize,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      store.close(); rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('native prompt init HTTP contract', () => {
  it('acknowledges native retries, preserves repeated equal turns, and validates IDs and conflicting bodies', async () => {
    const store = new SessionStore(':memory:', { syncOpsEnabled: false });
    const active = new Map<number, any>();
    const manager = {
      getSession: (id: number) => active.get(id),
      initializeSession: (id: number, _prompt: string, promptNumber: number) => {
        const row = store.getSessionById(id)!;
        const session = { contentSessionId: row.content_session_id, project: row.project, lastPromptNumber: promptNumber };
        active.set(id, session); return session;
      },
      getMessageBuffer: () => ({ getPendingCount: () => 0 }),
    };
    const routes = new SessionRoutes(manager as any,
      { getSessionStore: () => store, getCloudSync: () => undefined, getChromaSync: () => undefined } as any,
      {} as any, {} as any, {} as any, { broadcastNewPrompt() {}, broadcastSessionStarted() {} } as any,
      {} as any, {} as any);
    const app = express(); app.use(express.json({ limit: '1mb' })); routes.setupRoutes(app);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address() as { port: number };
    const init = async (body: any) => {
      const response = await fetch('http://127.0.0.1:' + address.port + '/api/sessions/init', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() as any };
    };
    try {
      const capability = await fetch('http://127.0.0.1:' + address.port + '/api/sessions/native-prompt-capability');
      expect(capability.status).toBe(200);
      expect(await capability.json()).toEqual({ nativePromptId: 1 });
      expect(store.db.query('SELECT COUNT(*) AS count FROM sdk_sessions').get()).toEqual({ count: 0 });
      const base = { contentSessionId: 'real-session', project: 'fixture', prompt: 'repeat me', platformSource: 'hermes' };
      const first = await init({ ...base, nativePromptId: 'native-1' });
      const second = await init({ ...base, nativePromptId: 'native-2' });
      expect(first.body.nativePromptId).toBe('native-1');
      expect(first.body.nativePromptCurrent).toBe(true);
      expect(second.body.nativePromptCurrent).toBe(true);
      expect(second.body.promptNumber).toBe(first.body.promptNumber + 1);
      const retry = await init({ ...base, nativePromptId: 'native-1' });
      expect(retry.body).toMatchObject({ skipped: true, reason: 'duplicate', nativePromptId: 'native-1', nativePromptCurrent: false, promptNumber: first.body.promptNumber });
      expect((await init({ ...base, nativePromptId: 'native-1', prompt: 'different' })).status).toBe(409);
      for (const nativePromptId of ['', 'white space', 'x'.repeat(257), 'a\u0000']) {
        expect((await init({ ...base, nativePromptId })).status).toBe(400);
      }
      const other = await init({ ...base, contentSessionId: 'another-session', nativePromptId: 'native-1' });
      expect(other.body.skipped).toBe(false);
      expect(other.body.sessionDbId).not.toBe(first.body.sessionDbId);
      const privateTurn = await init({ ...base, prompt: '<private>hidden</private>', nativePromptId: 'private-turn' });
      expect(privateTurn.body.reason).toBe('private');
      expect(store.getPromptNumberFromUserPrompts('real-session', first.body.sessionDbId)).toBe(2);
      const longPrompt = 'x'.repeat(270_000);
      expect((await init({ ...base, nativePromptId: 'long-ask', prompt: longPrompt + 'first' })).status).toBe(200);
      expect((await init({ ...base, nativePromptId: 'long-ask', prompt: longPrompt + 'different' })).status).toBe(409);
      const legacy = await init({ ...base, prompt: 'legacy text' });
      const legacyRetry = await init({ ...base, prompt: 'legacy text' });
      expect(legacyRetry.body.reason).toBe('duplicate');
      expect(legacyRetry.body.promptNumber).toBe(legacy.body.promptNumber);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      store.close();
    }
  });

  it('broadcasts and vector-syncs each turn\'s own prompt when two native turns are saved in the same millisecond', async () => {
    const store = new SessionStore(':memory:', { syncOpsEnabled: false });
    const active = new Map<number, any>();
    const manager = {
      getSession: (id: number) => active.get(id),
      initializeSession: (id: number, _prompt: string, promptNumber: number) => {
        const row = store.getSessionById(id)!;
        const session = { contentSessionId: row.content_session_id, project: row.project, lastPromptNumber: promptNumber };
        active.set(id, session); return session;
      },
      getMessageBuffer: () => ({ getPendingCount: () => 0 }),
    };
    const broadcast: { id: number; prompt_text: string }[] = [];
    const synced: { id: number; text: string }[] = [];
    const routes = new SessionRoutes(manager as any, {
      getSessionStore: () => store, getCloudSync: () => undefined,
      getChromaSync: () => ({ syncUserPrompt: async (id: number, _memorySessionId: unknown, _project: unknown, text: string) => { synced.push({ id, text }); } }),
    } as any, {} as any, {} as any, {} as any, {
      broadcastNewPrompt(prompt: { id: number; prompt_text: string }) { broadcast.push({ id: prompt.id, prompt_text: prompt.prompt_text }); },
      broadcastSessionStarted() {},
    } as any, {} as any, {} as any);
    routes.ensureGeneratorRunning = async () => {};
    const app = express(); app.use(express.json()); routes.setupRoutes(app);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address() as { port: number };
    const init = async (nativePromptId: string, prompt: string) => (await fetch('http://127.0.0.1:' + address.port + '/api/sessions/init', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contentSessionId: 'rapid-session', project: 'fixture', platformSource: 'hermes', nativePromptId, prompt }),
    })).status;
    setSystemTime(new Date('2026-10-05T11:00:00.000Z'));
    try {
      expect(await init('rapid-1', 'FIRST RAPID PROMPT')).toBe(200);
      expect(await init('rapid-2', 'SECOND RAPID PROMPT')).toBe(200);
      const rows = store.db.query('SELECT id, prompt_text, created_at_epoch FROM user_prompts ORDER BY id').all() as { id: number; prompt_text: string; created_at_epoch: number }[];
      expect(rows.map(row => row.prompt_text)).toEqual(['FIRST RAPID PROMPT', 'SECOND RAPID PROMPT']);
      expect(rows[0]!.created_at_epoch).toBe(rows[1]!.created_at_epoch);
      const own = rows.map(row => ({ id: row.id, prompt_text: row.prompt_text }));
      expect(broadcast).toEqual(own);
      expect(synced).toEqual(own.map(row => ({ id: row.id, text: row.prompt_text })));
    } finally {
      setSystemTime();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      store.close();
    }
  });

  it('repairs live context on retry after the real prompt claim commits but initialization fails', async () => {
    const fixture = await createRealSessionFixture();
    const { store, manager, starts } = fixture;
    const initialize = manager.initializeSession.bind(manager);
    try {
      const first = await fixture.init('turn-1', 'FIRST REAL PROMPT');
      expect(first.status).toBe(200);
      const sid = first.body.sessionDbId;
      let failOnce = true;
      manager.initializeSession = (...args) => {
        if (args[0] === sid && failOnce) {
          failOnce = false;
          throw new Error('Injected failure after durable prompt claim');
        }
        return initialize(...args);
      };
      const ask = '/SECOND REAL PROMPT <private>fixture private text</private>';
      expect((await fixture.init('turn-2', ask)).status).toBe(500);
      expect(store.getPromptNumberFromUserPrompts('recovery-session', sid)).toBe(2);
      expect(manager.getSession(sid)).toMatchObject({ lastPromptNumber: 1, userPrompt: 'FIRST REAL PROMPT' });

      const retry = await fixture.init('turn-2', ask);
      expect(retry).toMatchObject({ status: 200, body: {
        skipped: true, reason: 'duplicate', nativePromptId: 'turn-2', nativePromptCurrent: true, promptNumber: 2, contextInjected: true,
      } });
      expect(manager.getSession(sid)).toMatchObject({ lastPromptNumber: 2, userPrompt: 'SECOND REAL PROMPT', project: 'fixture' });
      expect(store.getPromptNumberFromUserPrompts('recovery-session', sid)).toBe(2);
      expect(starts).toHaveLength(1);

      expect(await fixture.observe('real-tool-2')).toEqual({ status: 200, body: { status: 'queued' } });
      expect(await fixture.summarize()).toEqual({ status: 200, body: { status: 'queued' } });
      const indexed = store.db.query('SELECT tool_use_id, prompt_number FROM tool_uses WHERE tool_use_id = ?').get('real-tool-2');
      expect(indexed).toEqual({ tool_use_id: 'real-tool-2', prompt_number: 2 });
      const buffered = manager.getMessageBuffer().getMessagesByIds(sid, [1, 2]);
      expect(buffered.map(message => ({ type: message.type, prompt_number: message.prompt_number, toolUseId: message.toolUseId }))).toEqual([
        { type: 'observation', prompt_number: 2, toolUseId: 'real-tool-2' },
        { type: 'summarize', prompt_number: 2, toolUseId: undefined },
      ]);
      expect(starts.slice(1)).toEqual([
        { source: 'observation', promptNumber: 2, userPrompt: 'SECOND REAL PROMPT' },
        { source: 'summarize', promptNumber: 2, userPrompt: 'SECOND REAL PROMPT' },
      ]);
    } finally {
      manager.initializeSession = initialize;
      await fixture.close();
    }
  });

  it('does not downgrade newer live context when an earlier durable receipt is retried', async () => {
    const fixture = await createRealSessionFixture();
    const { store, manager } = fixture;
    const initialize = manager.initializeSession.bind(manager);
    try {
      const first = await fixture.init('turn-1', 'FIRST REAL PROMPT');
      const sid = first.body.sessionDbId;
      manager.initializeSession = () => { throw new Error('Injected failure after prompt 2 claim'); };
      expect((await fixture.init('turn-2', 'SECOND REAL PROMPT')).status).toBe(500);
      manager.initializeSession = initialize;
      const third = await fixture.init('turn-3', 'THIRD REAL PROMPT');
      expect(third.body.promptNumber).toBe(3);

      let reinitializations = 0;
      manager.initializeSession = (...args) => { reinitializations++; return initialize(...args); };
      const older = await fixture.init('turn-2', 'SECOND REAL PROMPT');
      expect(older).toMatchObject({ status: 200, body: { reason: 'duplicate', nativePromptId: 'turn-2', nativePromptCurrent: false, promptNumber: 2, contextInjected: true } });
      expect(manager.getSession(sid)).toMatchObject({ lastPromptNumber: 3, userPrompt: 'THIRD REAL PROMPT' });
      expect(reinitializations).toBe(0);
      expect(store.getPromptNumberFromUserPrompts('recovery-session', sid)).toBe(3);
    } finally {
      manager.initializeSession = initialize;
      await fixture.close();
    }
  });

  it('advances real native continuation context when the accepted ask is only a slash', async () => {
    const fixture = await createRealSessionFixture();
    const { store, manager, starts } = fixture;
    try {
      const first = await fixture.init('turn-before-slash', 'FIRST REAL PROMPT');
      const sid = first.body.sessionDbId;
      const accepted = await fixture.init('slash-turn', '/');
      expect(accepted).toMatchObject({ status: 200, body: {
        skipped: false, nativePromptId: 'slash-turn', promptNumber: 2, contextInjected: true,
      } });
      expect(store.getUserPrompt('recovery-session', 2, sid)).toBe('/');
      expect(manager.getSession(sid)).toMatchObject({ lastPromptNumber: 2, userPrompt: '/' });
      expect(starts).toEqual([
        { source: 'init', promptNumber: 1, userPrompt: 'FIRST REAL PROMPT' },
        { source: 'init', promptNumber: 2, userPrompt: '/' },
      ]);

      expect(await fixture.observe('native-slash-tool')).toEqual({ status: 200, body: { status: 'queued' } });
      expect(await fixture.summarize()).toEqual({ status: 200, body: { status: 'queued' } });
      expect(store.db.query('SELECT tool_use_id, prompt_number FROM tool_uses WHERE tool_use_id = ?').get('native-slash-tool'))
        .toEqual({ tool_use_id: 'native-slash-tool', prompt_number: 2 });
      expect(manager.getMessageBuffer().getMessagesByIds(sid, [1, 2]).map(message => message.prompt_number)).toEqual([2, 2]);
      expect(starts.slice(2)).toEqual([
        { source: 'observation', promptNumber: 2, userPrompt: '/' },
        { source: 'summarize', promptNumber: 2, userPrompt: '/' },
      ]);
    } finally { await fixture.close(); }
  });

  it('repairs slash-only context after a committed native claim and failed live initialization', async () => {
    const fixture = await createRealSessionFixture();
    const { store, manager, starts } = fixture;
    const initialize = manager.initializeSession.bind(manager);
    try {
      const first = await fixture.init('turn-before-slash', 'FIRST REAL PROMPT');
      const sid = first.body.sessionDbId;
      let failOnce = true;
      manager.initializeSession = (...args) => {
        if (args[0] === sid && failOnce) {
          failOnce = false;
          throw new Error('Injected failure after slash-only native claim');
        }
        return initialize(...args);
      };
      expect((await fixture.init('slash-retry-turn', '/ <private>fixture secret</private>')).status).toBe(500);
      expect(store.getUserPrompt('recovery-session', 2, sid)).toBe('/');
      expect(manager.getSession(sid)).toMatchObject({ lastPromptNumber: 1, userPrompt: 'FIRST REAL PROMPT' });

      const retry = await fixture.init('slash-retry-turn', '/ <private>changed fixture secret</private>');
      expect(retry).toMatchObject({ status: 200, body: {
        skipped: true, reason: 'duplicate', nativePromptId: 'slash-retry-turn', promptNumber: 2, contextInjected: true,
      } });
      expect(manager.getSession(sid)).toMatchObject({ lastPromptNumber: 2, userPrompt: '/' });
      expect(store.getPromptNumberFromUserPrompts('recovery-session', sid)).toBe(2);
      expect(starts).toHaveLength(1);

      expect(await fixture.observe('native-slash-retry-tool')).toEqual({ status: 200, body: { status: 'queued' } });
      expect(await fixture.summarize()).toEqual({ status: 200, body: { status: 'queued' } });
      expect(store.db.query('SELECT tool_use_id, prompt_number FROM tool_uses WHERE tool_use_id = ?').get('native-slash-retry-tool'))
        .toEqual({ tool_use_id: 'native-slash-retry-tool', prompt_number: 2 });
      expect(manager.getMessageBuffer().getMessagesByIds(sid, [1, 2]).map(message => message.prompt_number)).toEqual([2, 2]);
      expect(starts.slice(1)).toEqual([
        { source: 'observation', promptNumber: 2, userPrompt: '/' },
        { source: 'summarize', promptNumber: 2, userPrompt: '/' },
      ]);
    } finally {
      manager.initializeSession = initialize;
      await fixture.close();
    }
  });

  it('keeps a cold native retry lazy and lets real observation ingest hydrate the saved prompt', async () => {
    const fixture = await createRealSessionFixture();
    const { store, manager, starts } = fixture;
    try {
      const sid = store.createSDKSession('recovery-session', 'fixture', 'REAL SAVED PROMPT', undefined, 'hermes');
      const receipt = store.saveNativeUserPrompt('recovery-session', sid, 'turn-after-exit', 'REAL SAVED PROMPT');
      const retry = await fixture.init('turn-after-exit', 'REAL SAVED PROMPT');
      expect(retry).toMatchObject({ status: 200, body: {
        reason: 'duplicate', nativePromptId: 'turn-after-exit', nativePromptCurrent: true, promptNumber: receipt.promptNumber, contextInjected: false,
      } });
      expect(manager.getSession(sid)).toBeUndefined();
      expect(starts).toHaveLength(0);
      expect(await fixture.observe('real-after-exit-tool')).toEqual({ status: 200, body: { status: 'queued' } });
      expect(manager.getSession(sid)).toMatchObject({ lastPromptNumber: receipt.promptNumber, userPrompt: 'REAL SAVED PROMPT' });
      expect(await fixture.summarize()).toEqual({ status: 200, body: { status: 'queued' } });
      expect(store.db.query('SELECT prompt_number FROM tool_uses WHERE tool_use_id = ?').get('real-after-exit-tool'))
        .toEqual({ prompt_number: receipt.promptNumber });
      expect(manager.getMessageBuffer().getMessagesByIds(sid, [1, 2]).map(message => message.prompt_number))
        .toEqual([receipt.promptNumber, receipt.promptNumber]);
    } finally { await fixture.close(); }
  });
});
