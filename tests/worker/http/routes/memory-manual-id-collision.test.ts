import { expect, it } from 'bun:test';
import express from 'express';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { MemoryRoutes } from '../../../../src/services/worker/http/routes/MemoryRoutes.js';

for (const legacy of [false, true]) {
  it(`keeps colliding manual project/source tuples separate${legacy ? ' beside an older session' : ''} across restart`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'manual-id-collision-'));
    const dbPath = join(directory, 'memory.db');
    const previousGrok = process.env.CLAUDE_MEM_GROK_BOT_INJECT_ENABLED;
    const previousNotion = process.env.CLAUDE_MEM_NOTION_ENABLED;
    process.env.CLAUDE_MEM_GROK_BOT_INJECT_ENABLED = 'false';
    process.env.CLAUDE_MEM_NOTION_ENABLED = 'false';
    let store = new SessionStore(dbPath);
    const scopes = [
      { project: 'alpha-deepseek', platformSource: 'harness' },
      { project: 'alpha', platformSource: 'deepseek-harness' },
    ];
    const oldMemoryId = 'manual-alpha-deepseek-harness';
    if (legacy) store.db.query(`
      INSERT INTO sdk_sessions(memory_session_id, content_session_id, project, platform_source, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, '2026-09-01T00:00:00.000Z', 1788220800000, 'active')
    `).run(oldMemoryId, oldMemoryId, scopes[0].project, scopes[0].platformSource);
    const app = express();
    app.use(express.json());
    new MemoryRoutes({
      getSessionStore: () => store, getConnection: () => store.db,
      getCloudSync: () => null, getChromaSync: () => null,
    } as any, 'default-project').setupRoutes(app);
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/memory/save`;
    const save = async (scope: typeof scopes[number], suffix: string) => {
      const response = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: scope.project, text: `${scope.platformSource} note ${suffix}`,
          metadata: { platformSource: scope.platformSource } }),
      });
      expect(response.status).toBe(200);
      expect((await response.json()).success).toBe(true);
    };
    const sessions = () => store.db.query(`
      SELECT memory_session_id, project, platform_source FROM sdk_sessions ORDER BY platform_source
    `).all() as Array<{ memory_session_id: string; project: string; platform_source: string }>;
    try {
      for (const scope of scopes) await save(scope, 'first');
      const before = sessions();
      expect(before).toHaveLength(2);
      expect(new Set(before.map(row => row.memory_session_id)).size).toBe(2);
      expect(before.find(row => row.platform_source === 'harness')?.memory_session_id).toBe(oldMemoryId);
      for (const scope of scopes) {
        const row = before.find(row => row.platform_source === scope.platformSource)!;
        expect(row.project).toBe(scope.project);
        expect(store.getObservationsForSession(row.memory_session_id, scope.platformSource)).toHaveLength(1);
      }

      store.close();
      store = new SessionStore(dbPath);
      for (const scope of scopes) await save(scope, 'after restart');
      expect(sessions()).toEqual(before);
      for (const scope of scopes) {
        const row = before.find(row => row.platform_source === scope.platformSource)!;
        const observations = store.getObservationsForSession(row.memory_session_id, scope.platformSource);
        expect(observations).toHaveLength(2);
        expect(observations.map(observation => observation.title).sort()).toEqual([
          `${scope.platformSource} note after restart`, `${scope.platformSource} note first`,
        ]);
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      store.close();
      if (previousGrok === undefined) delete process.env.CLAUDE_MEM_GROK_BOT_INJECT_ENABLED;
      else process.env.CLAUDE_MEM_GROK_BOT_INJECT_ENABLED = previousGrok;
      if (previousNotion === undefined) delete process.env.CLAUDE_MEM_NOTION_ENABLED;
      else process.env.CLAUDE_MEM_NOTION_ENABLED = previousNotion;
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
