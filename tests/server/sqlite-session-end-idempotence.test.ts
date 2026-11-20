import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { ServerV1Routes } from '../../src/server/routes/v1/ServerV1Routes.js';
import { ProjectsRepository, ServerSessionsRepository } from '../../src/storage/sqlite/index.js';

describe('SQLite session completion preserves terminal history', () => {
  let db: Database;
  let server: Server;
  let base: string;
  let projectId: string;
  beforeEach(async () => {
    db = new Database(':memory:');
    db.run('PRAGMA foreign_keys = ON');
    projectId = new ProjectsRepository(db).create({ name: 'Completion retries' }).id;
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
  });
  const end = (id: string) => fetch(`${base}/v1/sessions/${id}/end`, { method: 'POST' });
  const session = () => {
    const repo = new ServerSessionsRepository(db);
    const row = repo.create({ projectId });
    db.prepare('UPDATE server_sessions SET started_at_epoch = 100, updated_at_epoch = 100 WHERE id = ?').run(row.id);
    return { repo, id: row.id };
  };

  test('repeated repository completion preserves the first completion timestamp', () => {
    const { repo, id } = session();
    const completed = repo.markCompleted(id, 200);
    expect(completed?.status).toBe('completed');
    expect(completed?.completedAtEpoch).toBe(200);
    expect(repo.markCompleted(id, 900)).toEqual(completed);
  });

  test('retried HTTP end requests return the same completed session', async () => {
    const { repo, id } = session();
    const completed = repo.markCompleted(id, 200);
    for (let request = 0; request < 2; request++) {
      const response = await end(id);
      expect(response.status).toBe(200);
      expect((await response.json()).session).toEqual(completed);
    }
    expect(repo.getById(id)).toEqual(completed);
  });

  test('ending a failed session does not rewrite it as successful completion', async () => {
    const { repo, id } = session();
    db.prepare("UPDATE server_sessions SET status = 'failed', completed_at_epoch = 200, updated_at_epoch = 200 WHERE id = ?").run(id);
    const failed = repo.getById(id);
    const response = await end(id);
    expect(response.status).toBe(200);
    expect((await response.json()).session).toEqual(failed);
    expect(repo.markCompleted(id, 900)).toEqual(failed);
  });

  test('active sessions still complete and missing sessions still return 404', async () => {
    const { id } = session();
    const response = await end(id);
    expect(response.status).toBe(200);
    const { session: completed } = await response.json();
    expect(completed.status).toBe('completed');
    expect(completed.completedAtEpoch).toBeGreaterThanOrEqual(completed.startedAtEpoch);
    expect(completed.updatedAtEpoch).toBe(completed.completedAtEpoch);
    expect((await end('missing')).status).toBe(404);
  });
});
