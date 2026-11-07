import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import express from 'express';
import type { Server } from 'http';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SearchRoutes } from '../../../../src/services/worker/http/routes/SearchRoutes.js';
import { SearchManager } from '../../../../src/services/worker/SearchManager.js';
import { SessionSearch } from '../../../../src/services/sqlite/SessionSearch.js';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { FormattingService } from '../../../../src/services/worker/FormattingService.js';
import { TimelineService } from '../../../../src/services/worker/TimelineService.js';

const PROJECT = 'billing-api';
const QUESTION = 'What was our Redis connection pool limit?';
const KEYWORDS = 'Redis connection pool limit';
const DECISION = 'Redis connection pool limit: 12 per process; 4 processes; total 48 connections.';

type Observation = { id: number; project: string; narrative: string };

describe('SQLite search and semantic context after same-topic memory growth', () => {
  let directory: string;
  let store: SessionStore;
  let server: Server;
  let baseUrl: string;
  let sequence: number;
  let sessions: Map<string, string>;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'claude-mem-evidence-growth-'));
    store = new SessionStore(join(directory, 'memory.db'));
    sequence = 0;
    sessions = new Map();
    // Exercise the production SQLite path, without a Chroma service or model.
    const manager = new SearchManager(new SessionSearch(store.db), store, null,
      new FormattingService(), new TimelineService());
    const app = express();
    app.use(express.json());
    new SearchRoutes(manager).setupRoutes(app);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function add(title: string, narrative: string, project = PROJECT): number {
    let memorySessionId = sessions.get(project);
    if (!memorySessionId) {
      memorySessionId = `memory-${project}`;
      const sessionId = store.createSDKSession(`content-${project}`, project, 'Coding task');
      store.ensureMemorySessionIdRegistered(sessionId, memorySessionId);
      sessions.set(project, memorySessionId);
    }
    return store.storeObservation(memorySessionId, project, {
      type: 'decision', title, subtitle: null, narrative, facts: [],
      concepts: [], files_read: [], files_modified: [],
    }, 1, 0, Date.now() + sequence++).id;
  }

  async function search(query: string, options: Record<string, string> = {}): Promise<Observation[]> {
    const response = await fetch(`${baseUrl}/api/search?${new URLSearchParams({
      query, project: PROJECT, type: 'observations', format: 'json', limit: '100', ...options,
    })}`);
    expect(response.status).toBe(200);
    return (await response.json() as { observations: Observation[] }).observations;
  }

  async function context(): Promise<{ context: string; count: number }> {
    const response = await fetch(`${baseUrl}/api/context/semantic`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: QUESTION, project: PROJECT, limit: 20 }),
    });
    expect(response.status).toBe(200);
    return response.json();
  }

  for (const [initialUnrelated, relatedCount] of [[0, 2], [60, 40]]) {
    it(`keeps the decision discoverable with ${relatedCount} related notes among ${initialUnrelated + relatedCount}`, async () => {
      for (let i = 0; i < initialUnrelated; i++) {
        add(`Shipping rollout checklist ${i}`, `Validate deployment metadata and approval tracking ${i}.`);
      }
      const targetId = add(KEYWORDS, DECISION);
      expect((await search(QUESTION)).map(row => row.id)).toEqual([targetId]);
      expect((await context()).context).toContain(DECISION);

      for (let i = 1; i < relatedCount; i++) {
        add(`${KEYWORDS} rationale ${i}`,
          `Redis connection pool limit avoids exhausting the shared service across replicas; deployment note ${i}.`);
      }

      // The records and their evidence still exist: the natural question must
      // not lose them merely because its content terms became relatively common.
      const keywords = await search(KEYWORDS);
      expect(keywords).toHaveLength(relatedCount);
      expect(keywords.find(row => row.id === targetId)?.narrative).toBe(DECISION);
      const question = await search(QUESTION);
      expect(question).toHaveLength(relatedCount);
      expect(question.find(row => row.id === targetId)?.narrative).toBe(DECISION);
      const semantic = await context();
      expect(semantic.count).toBe(Math.min(20, relatedCount));
      expect(semantic.context).toContain(DECISION);

      // Admission must leave the route's scope and pagination semantics intact.
      add(KEYWORDS, 'Another project has its own connection budget.', 'other-project');
      const scoped = await search(QUESTION, { orderBy: 'date_asc' });
      expect(scoped).toHaveLength(relatedCount);
      expect(scoped.every(row => row.project === PROJECT)).toBe(true);
      const page = await search(QUESTION, { orderBy: 'date_asc', limit: '1', offset: '1' });
      expect(page.map(row => row.id)).toEqual(scoped.slice(1, 2).map(row => row.id));
      expect(await search(QUESTION, { project: 'absent-project' })).toEqual([]);
    });
  }
});
