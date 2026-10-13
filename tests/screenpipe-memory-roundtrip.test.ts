import { expect, it } from 'bun:test';
import express from 'express';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { SessionStore } from '../src/services/sqlite/SessionStore.js';
import { MemoryRoutes } from '../src/services/worker/http/routes/MemoryRoutes.js';
import { run } from '../plugin/skills/screenpipe/screenpipe.mjs';

it('persists a Screenpipe note through the real worker route and reads it after reopening SQLite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'screenpipe-roundtrip-'));
  const dbPath = join(dir, 'memory.db');
  const file = join(dir, 'selected.md');
  const text = 'Release Friday. Source: Screenpipe Audio #20 at 2026-10-07T16:31:00Z.';
  await writeFile(file, text);
  let store = new SessionStore(dbPath);
  const app = express();
  app.use(express.json());
  new MemoryRoutes({
    getSessionStore: () => store,
    getChromaSync: () => null,
    getCloudSync: () => null,
  } as any, 'fallback-project').setupRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as { port: number };
    const saved = await run(['save', '--file', file, '--project', 'screenpipe-demo', '--worker-url', `http://127.0.0.1:${address.port}`]);
    expect(saved.success).toBe(true);
    store.close();
    store = new SessionStore(dbPath);
    const observation = store.getObservationById(saved.id);
    expect(observation?.project).toBe('screenpipe-demo');
    expect(observation?.narrative).toBe(text);
    expect(JSON.parse(observation!.metadata!)).toEqual({ source: 'screenpipe' });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
