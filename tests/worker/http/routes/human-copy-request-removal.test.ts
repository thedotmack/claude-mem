import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Response } from 'express';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { DataRoutes } from '../../../../src/services/worker/http/routes/DataRoutes.js';
import { WorkViewRoutes } from '../../../../src/services/worker/http/routes/WorkViewRoutes.js';
import { HumanCopyWorker, chatCompletionsHumanCopyProvider } from '../../../../src/services/work-view/human-copy-worker.mjs';

for (const mode of ['queued', 'paused', 'late-success', 'late-failure'] as const) {
  it(`retires ${mode} wording work when the actual session-delete route removes its request`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'human-copy-removal-'));
    const databasePath = join(directory, 'memory.db');
    const store = new SessionStore(databasePath);
    const project = 'wording-removal';
    const seed = (id: string, prompt: string) => {
      const session = store.createSDKSession(id, project, prompt);
      store.updateMemorySessionId(session, `memory-${id}`);
      store.saveUserPrompt(id, 1, prompt, session);
      store.storeObservation(`memory-${id}`, project, {
        type: 'feature', title: `Recorded ${id}`, subtitle: null, narrative: 'The recorded work is available.',
        facts: [], concepts: [], files_read: [], files_modified: [],
      }, 1);
      store.markSessionCompleted(session);
    };
    seed('removed', 'Build the original work viewer.');
    const app = express();
    app.use(express.json());
    const sends: Array<{ response: Response; input: any }> = [];
    const delayed = mode === 'queued' || mode === 'paused';
    let holdReplies = !delayed;
    const reply = (send: typeof sends[number], status = 200) => {
      if (status !== 200) { send.response.status(status).json({ error: 'fixture unavailable' }); return; }
      send.response.json({ choices: [{ message: { content: JSON.stringify({
        title: 'Show the recorded work', summary: 'The recorded work is available.', next: '',
        workstreams: send.input.workstreams.map((stream: { id: string }) => ({ id: stream.id, title: 'Recorded work', summary: 'Available.' })),
      }) } }], usage: { prompt_tokens: 20, completion_tokens: 10 }, model: 'fixture' });
    };
    app.post('/fixture-completions', (request, response) => {
      const send = { response, input: JSON.parse(request.body.messages[1].content) };
      sends.push(send);
      if (!holdReplies) reply(send);
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    let now = 0;
    const saved: Array<{ id: string; value: unknown }> = [];
    const copy = new HumanCopyWorker({
      provider: chatCompletionsHumanCopyProvider({ url: `${origin}/fixture-completions`, apiKey: '', model: 'fixture' }),
      cachePath: null, persistSharedCopy: async (id: string, value: unknown) => { saved.push({ id, value }); },
      quietMs: delayed ? 100 : 0, minIntervalMs: 0, retryMs: 100, now: () => now, warn() {},
    });
    const viewRoutes = new WorkViewRoutes({
      databasePath, reviewPath: join(directory, 'reviews.db'), ledgerDir: null,
      setupStatePath: join(directory, 'setup-state.json'), humanCopy: copy,
      focusShares: null, autoRefresh: null, pollIntervalMs: 100000,
    });
    const manager = { getSessionStore: () => store, getConnection: () => store.db, getCloudSync: () => null, getChromaSync: () => null };
    new DataRoutes({} as any, manager as any, { getSession: () => undefined } as any,
      { broadcast() {} } as any, {} as any, Date.now()).setupRoutes(app);
    viewRoutes.setupRoutes(app);
    const view = async () => {
      const response = await fetch(`${origin}/api/work-view`);
      expect(response.status).toBe(200);
      const result = await response.json() as any;
      expect(result.source.connected).toBe(true);
      expect(result.source.stale).toBe(false);
      return result;
    };
    const until = async (condition: () => boolean) => {
      for (let i = 0; i < 100 && !condition(); i++) await Bun.sleep(10);
      expect(condition()).toBe(true);
    };
    try {
      const before = await view();
      expect(before.humanRequests).toHaveLength(1);
      const removedId = before.humanRequests[0].id;
      expect(copy.status().queued).toBe(1);
      if (!delayed) await until(() => sends.length === 1);
      if (mode === 'paused') copy.pauseWhile(() => true);
      const deletion = await fetch(`${origin}/api/sessions/claude/removed`, { method: 'DELETE' });
      expect(deletion.status).toBe(200);
      expect((await deletion.json() as any).success).toBe(true);
      const after = await view();
      expect(after.humanRequests).toEqual([]);
      expect(store.db.query('SELECT COUNT(*) AS n FROM user_prompts').get()).toEqual({ n: 0 });
      if (!delayed) {
        reply(sends[0], mode === 'late-failure' ? 503 : 200);
        await until(() => copy.status().generating === 0);
      }
      copy.pauseWhile(() => false);
      now = 10000;
      copy.pump();
      await Bun.sleep(30);
      expect(sends).toHaveLength(delayed ? 0 : 1);
      expect(saved).toEqual([]);
      expect(copy.status().queued).toBe(0);
      expect(copy.status().failures).toEqual([]);
      expect(copy.cache.has(removedId)).toBe(false);

      // Fresh surviving work still gets one generation and a stored copy.
      holdReplies = false;
      seed('fresh', 'Build a different new report.');
      const fresh = await view();
      expect(fresh.humanRequests).toHaveLength(1);
      now += 1000;
      copy.pump();
      await until(() => saved.length === 1 && copy.status().generating === 0);
      expect(saved[0].id).toBe(fresh.humanRequests[0].id);
      expect((await view()).humanRequests[0].humanCopy.state).toBe('current');
    } finally {
      for (const send of sends) if (!send.response.writableEnded) send.response.destroy();
      viewRoutes.close();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 10000);
}
