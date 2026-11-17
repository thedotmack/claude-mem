import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import express from 'express';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../src/services/sqlite/SessionSearch.js';
import { DataRoutes } from '../../src/services/worker/http/routes/DataRoutes.js';
import { createMiddleware } from '../../src/services/worker/http/middleware.js';
import { errorHandler } from '../../src/services/server/ErrorHandler.js';
import { WORKER_JSON_BODY_LIMIT_BYTES } from '../../src/shared/worker-http-limits.js';

describe('memory import request sizes', () => {
  let directory: string;
  let store: SessionStore;
  let server: Server;
  let requests: number[];
  let oldWorker: boolean;
  let rejectRequest: number | undefined;
  let rebuilds: number;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'cmem-import-size-'));
    store = new SessionStore(':memory:');
    new SessionSearch(store.db);
    requests = [];
    oldWorker = false;
    rejectRequest = undefined;
    rebuilds = 0;
    const rebuild = store.rebuildObservationsFTSIndex.bind(store);
    store.rebuildObservationsFTSIndex = () => { rebuilds++; rebuild(); };
    const app = express();
    app.use((req, res, next) => {
      if (req.path === '/api/import') requests.push(Number(req.headers['content-length']));
      if (req.path === '/api/import' && requests.length === rejectRequest) {
        res.status(503).json({ error: 'fixture worker unavailable' });
        return;
      }
      if (oldWorker && req.path === '/api/import') {
        const json = res.json.bind(res);
        res.json = body => { delete body.sessionIdentities; return json(body); };
      }
      next();
    });
    app.use(createMiddleware());
    app.get('/api/stats', (_req, res) => res.json({}));
    new DataRoutes({} as any, { getSessionStore: () => store, getChromaSync: () => null } as any,
      {} as any, {} as any, {} as any, Date.now()).setupRoutes(app);
    app.use(errorHandler);
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    writeFileSync(join(directory, 'settings.json'), JSON.stringify({
      CLAUDE_MEM_WORKER_PORT: String((server.address() as AddressInfo).port),
    }));
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function exportedMemory(large = true) {
    const source = new SessionStore(':memory:');
    try {
      const memoryIds: string[] = [];
      const promptIds: number[] = [];
      const observationIds: number[] = [];
      const summaryIds: number[] = [];
      for (const platform of ['claude', 'cursor', 'codex']) {
        const session = source.createSDKSession('shared-content', 'import-project', 'Original prompt', undefined, platform);
        const memory = `exported-${platform}`;
        source.ensureMemorySessionIdRegistered(session, memory);
        memoryIds.push(memory);
        promptIds.push(source.saveUserPrompt('shared-content', 1, `Original ${platform} prompt`, session));
        observationIds.push(source.storeObservation(memory, 'import-project', {
          type: 'decision', title: `${platform} Unicode export`, subtitle: null,
          // Each row fits; three rows exceed the worker's actual UTF-8 byte limit.
          narrative: large ? '知识'.repeat(350_000) : 'small observation',
          facts: [], concepts: [], files_read: [], files_modified: [],
        }, 1).id);
        summaryIds.push(source.storeSummary(memory, 'import-project', {
          request: `${platform} request`, investigated: 'Stored history', learned: 'Preserve ownership',
          completed: `${platform} result`, next_steps: 'Import', notes: null,
        }, 1).id);
      }
      return {
        sessions: source.getSdkSessionsBySessionIds(memoryIds),
        summaries: source.getSessionSummariesByIds(summaryIds),
        observations: source.getObservationsByIds(observationIds),
        prompts: source.getUserPromptsByIds(promptIds),
      };
    } finally { source.close(); }
  }

  async function run(payload: unknown) {
    const file = join(directory, 'export.json');
    writeFileSync(file, JSON.stringify(payload));
    const child = Bun.spawn([process.execPath, '--preload', join(import.meta.dir, '../preload.ts'),
      join(import.meta.dir, '../../scripts/import-memories.ts'), file], {
      cwd: directory,
      env: { ...process.env, CLAUDE_MEM_DATA_DIR: directory, CLAUDE_CONFIG_DIR: join(directory, 'config') },
      stdout: 'pipe', stderr: 'pipe',
    });
    const [status, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    return { status, stdout, stderr };
  }

  it('imports a large Unicode export with existing local session identities and skips its replay', async () => {
    const payload = exportedMemory();
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeGreaterThan(WORKER_JSON_BODY_LIMIT_BYTES);
    expect(JSON.stringify(payload).length).toBeLessThan(WORKER_JSON_BODY_LIMIT_BYTES);
    for (const platform of ['claude', 'cursor']) {
      const session = store.createSDKSession('shared-content', 'import-project', 'Keep local prompt', 'Keep title', platform);
      store.ensureMemorySessionIdRegistered(session, `local-${platform}`);
    }
    const result = await run(payload);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Sessions:     1 imported, 2 skipped, 0 rejected');
    for (const label of ['Summaries:', 'Observations:', 'Prompts:']) {
      expect(result.stdout).toMatch(new RegExp(`${label}\\s+3 imported, 0 skipped, 0 rejected`));
    }
    expect(requests.length).toBeGreaterThan(1);
    expect(requests.every(size => size <= WORKER_JSON_BODY_LIMIT_BYTES)).toBe(true);
    const rows = store.db.query(`SELECT o.narrative, s.platform_source, s.memory_session_id FROM observations o
      JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id ORDER BY s.platform_source`).all() as any[];
    expect(rows.map(row => [row.platform_source, row.memory_session_id])).toEqual([
      ['claude', 'local-claude'], ['codex', 'exported-codex'], ['cursor', 'local-cursor'],
    ]);
    expect(rows.every(row => row.narrative === '知识'.repeat(350_000))).toBe(true);
    expect(store.db.query(`SELECT s.platform_source, p.prompt_text FROM user_prompts p
      JOIN sdk_sessions s ON s.id = p.session_db_id ORDER BY s.platform_source`).all()).toEqual([
      { platform_source: 'claude', prompt_text: 'Original claude prompt' },
      { platform_source: 'codex', prompt_text: 'Original codex prompt' },
      { platform_source: 'cursor', prompt_text: 'Original cursor prompt' },
    ]);
    expect(store.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    const replay = await run(payload);
    expect(replay.status, replay.stderr).toBe(0);
    for (const label of ['Sessions:', 'Summaries:', 'Observations:', 'Prompts:']) {
      expect(replay.stdout).toMatch(new RegExp(`${label}\\s+0 imported, 3 skipped, 0 rejected`));
    }
    expect(store.db.query('SELECT count(*) AS n FROM observations').get()).toEqual({ n: 3 });
  }, 30_000);

  it('keeps a small export on the existing single-request path', async () => {
    const result = await run(exportedMemory(false));
    expect(result.status, result.stderr).toBe(0);
    expect(requests).toHaveLength(1);
    expect(store.db.query('SELECT count(*) AS n FROM observations').get()).toEqual({ n: 3 });
  });

  it('splits the parent sessions too and preserves a legacy prompt without a platform field', async () => {
    const payload = exportedMemory(false);
    for (const session of payload.sessions) session.user_prompt = '知识'.repeat(350_000);
    const claudeSession = payload.sessions.find(row => row.platform_source === 'claude')!;
    const claudePrompt = payload.prompts.find(row => row.platform_source === 'claude')!;
    claudeSession.content_session_id = 'legacy-content';
    claudePrompt.content_session_id = 'legacy-content';
    delete (claudePrompt as any).platform_source;
    const result = await run(payload);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Sessions:     3 imported, 0 skipped, 0 rejected');
    expect(requests.every(size => size <= WORKER_JSON_BODY_LIMIT_BYTES)).toBe(true);
    expect(store.db.query(`SELECT s.platform_source, p.prompt_text FROM user_prompts p
      JOIN sdk_sessions s ON s.id = p.session_db_id ORDER BY s.platform_source`).all()).toEqual([
      { platform_source: 'claude', prompt_text: 'Original claude prompt' },
      { platform_source: 'codex', prompt_text: 'Original codex prompt' },
      { platform_source: 'cursor', prompt_text: 'Original cursor prompt' },
    ]);
    expect(store.db.query('SELECT count(*) AS n FROM observations').get()).toEqual({ n: 3 });
    expect(store.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  }, 30_000);

  it('reports a rejected row using its original export index after a request boundary', async () => {
    const payload = exportedMemory();
    payload.observations.push({ ...payload.observations[0], memory_session_id: null } as any);
    const result = await run(payload);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Observations: 3 imported, 0 skipped, 1 rejected');
    expect(result.stdout).toContain('observations[3] rejected:');
    expect(store.db.query('SELECT count(*) AS n FROM observations').get()).toEqual({ n: 3 });
  }, 30_000);

  it('refuses an indivisible oversized row before writing any earlier rows', async () => {
    const payload = exportedMemory(false);
    payload.observations[2].narrative = 'x'.repeat(WORKER_JSON_BODY_LIMIT_BYTES);
    const result = await run(payload);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("observations[2] exceeds the worker's");
    expect(requests).toHaveLength(0);
    expect(store.db.query('SELECT count(*) AS n FROM sdk_sessions').get()).toEqual({ n: 0 });
  });

  it('checks resolved row sizes before importing any children and reports the original row index', async () => {
    const payload = exportedMemory(false);
    const session = store.createSDKSession('shared-content', 'import-project', 'Keep local prompt', undefined, 'claude');
    store.ensureMemorySessionIdRegistered(session, 'destination-memory-'.repeat(256));
    const index = payload.observations.findIndex(row => row.memory_session_id === 'exported-claude');
    const row = payload.observations[index];
    row.narrative = '';
    const overhead = Buffer.byteLength(JSON.stringify({ observations: [row] }));
    row.narrative = 'x'.repeat(WORKER_JSON_BODY_LIMIT_BYTES - overhead - 64);
    expect(Buffer.byteLength(JSON.stringify({ observations: [row] }))).toBeLessThan(WORKER_JSON_BODY_LIMIT_BYTES);
    const result = await run(payload);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`observations[${index}] exceeds the worker's`);
    expect(result.stderr).toContain('after resolving its session');
    // Destination identities are only available after the parent request.
    // Its accepted sessions remain, but no child batch should have started.
    expect(requests).toHaveLength(1);
    expect(store.db.query('SELECT count(*) AS n FROM sdk_sessions').get()).toEqual({ n: 3 });
    for (const table of ['session_summaries', 'observations', 'user_prompts']) {
      expect(store.db.query(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
    expect(result.stdout).not.toContain('Import complete!');
  });

  it('keeps accepted chunks searchable after a later failure without rebuilding all observations', async () => {
    rejectRequest = 4;
    const result = await run(exportedMemory());
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('503');
    expect(requests).toHaveLength(4);
    expect(store.db.query("SELECT count(*) AS n FROM observations_fts WHERE observations_fts MATCH 'Unicode'").get())
      .toEqual({ n: 2 });
    expect(store.db.query("SELECT count(*) AS n FROM session_summaries_fts WHERE session_summaries_fts MATCH 'ownership'").get())
      .toEqual({ n: 3 });
    expect(rebuilds).toBe(0);
  }, 30_000);

  it('requires the worker identity response before importing children in another request', async () => {
    oldWorker = true;
    const result = await run(exportedMemory());
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Update the worker');
    expect(requests).toHaveLength(1);
    expect(store.db.query('SELECT count(*) AS n FROM observations').get()).toEqual({ n: 0 });
    expect(result.stdout).not.toContain('Import complete!');
  }, 30_000);

  it('stops on a failed request without retrying it or reporting completion', async () => {
    rejectRequest = 2;
    const result = await run(exportedMemory());
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('503');
    expect(requests).toHaveLength(2);
    expect(store.db.query('SELECT count(*) AS n FROM observations').get()).toEqual({ n: 0 });
    expect(result.stdout).not.toContain('Import complete!');
  }, 30_000);
});
