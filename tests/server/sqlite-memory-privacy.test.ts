import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { ServerV1Routes } from '../../src/server/routes/v1/ServerV1Routes.js';
import { MemoryItemsRepository, ProjectsRepository } from '../../src/storage/sqlite/index.js';
import { _resetRedactionConfigCache } from '../../src/utils/redaction.js';

describe('SQLite memory writes apply privacy before persistence and indexing', () => {
  let db: Database;
  let server: Server;
  let base: string;
  let projectId: string;
  let oldRedaction: string | undefined;
  const secret = 'ghp_' + 'A'.repeat(36);
  const hidden = 'privatecanary';

  beforeEach(async () => {
    oldRedaction = process.env.CLAUDE_MEM_REDACT_ENABLED;
    process.env.CLAUDE_MEM_REDACT_ENABLED = 'true';
    _resetRedactionConfigCache();
    db = new Database(':memory:');
    db.run('PRAGMA foreign_keys = ON');
    projectId = new ProjectsRepository(db).create({ name: 'Privacy boundary' }).id;
    const app = express();
    app.use(express.json());
    new ServerV1Routes({ getDatabase: () => db, authMode: 'local-dev', allowLocalDevBypass: true }).setupRoutes(app);
    server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test port');
    base = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    db.close();
    if (oldRedaction === undefined) delete process.env.CLAUDE_MEM_REDACT_ENABLED;
    else process.env.CLAUDE_MEM_REDACT_ENABLED = oldRedaction;
    _resetRedactionConfigCache();
  });

  const request = (path: string, body: unknown, method = 'POST') => fetch(base + path, {
    method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const privateContent = () => ({
    title: `<private>${hidden}</private>`,
    subtitle: `public ${secret}`,
    text: `searchable <private>${hidden}</private>`,
    narrative: `narrative ${secret}`,
    facts: [`fact ${secret}`], concepts: [`concept <private>${hidden}</private>`],
    filesRead: [`/read/${secret}`], filesModified: [`<private>${hidden}</private>/safe`],
    metadata: { nested: [{ value: `public ${secret} <private>${hidden}</private>` }] },
  });
  const expectSafe = (value: unknown) => {
    const serialized = JSON.stringify(value);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(hidden);
  };

  test('POST and PATCH sanitize responses, stored columns, search and context', async () => {
    const created = await request('/v1/memories', { projectId, kind: 'manual', type: 'note', ...privateContent() });
    expect(created.status).toBe(201);
    const { memory } = await created.json();
    expectSafe(memory);
    expect(memory.title).toBeNull();
    expect(memory.subtitle).toContain('redacted');
    const updated = await request(`/v1/memories/${memory.id}`, privateContent(), 'PATCH');
    expect(updated.status).toBe(200);
    expectSafe(await updated.json());
    expectSafe(db.query('SELECT * FROM memory_items WHERE id = ?').get(memory.id));
    expectSafe(db.query('SELECT * FROM memory_items_fts').all());
    expectSafe(await (await fetch(`${base}/v1/memories/${memory.id}`)).json());
    for (const path of ['/v1/search', '/v1/context']) {
      const response = await request(path, { projectId, query: 'searchable' });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.memories.map((row: { id: string }) => row.id)).toEqual([memory.id]);
      expectSafe(body);
    }
    const hiddenSearch = await request('/v1/search', { projectId, query: hidden });
    expect((await hiddenSearch.json()).memories).toEqual([]);
  });

  test('private-only writes cannot create or clear the last searchable field', async () => {
    const privateOnly = `<private>${hidden}</private>`;
    const created = await request('/v1/memories', { projectId, kind: 'manual', type: 'note', title: privateOnly });
    expect(created.status).toBe(400);
    expect(db.query('SELECT COUNT(*) AS count FROM memory_items').get()).toEqual({ count: 0 });
    const { memory } = await (await request('/v1/memories', { projectId, kind: 'manual', type: 'note', text: 'keep this' })).json();
    const updated = await request(`/v1/memories/${memory.id}`, { text: privateOnly }, 'PATCH');
    expect(updated.status).toBe(400);
    expect(new MemoryItemsRepository(db).getById(memory.id)?.text).toBe('keep this');
  });

  test('repository callers are covered and partial updates preserve omitted fields', () => {
    const repo = new MemoryItemsRepository(db);
    const memory = repo.create({ projectId, kind: 'manual', type: 'note', ...privateContent() });
    expectSafe(memory);
    const updated = repo.update(memory.id, { text: `replacement ${secret}` });
    expectSafe(updated);
    expect(updated?.subtitle).toBe(memory.subtitle);
    expect(updated?.metadata).toEqual(memory.metadata);
  });

  test('disabled secret redaction preserves plain text while private tags still apply', () => {
    process.env.CLAUDE_MEM_REDACT_ENABLED = 'false';
    _resetRedactionConfigCache();
    const repo = new MemoryItemsRepository(db);
    const memory = repo.create({ projectId, kind: 'manual', type: 'note', text: `  ${secret}\n`,
      metadata: { nested: `<private>${hidden}</private>visible` } });
    expect(memory.text).toBe(`  ${secret}\n`);
    expect(memory.metadata).toEqual({ nested: 'visible' });
  });
});
