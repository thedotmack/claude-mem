import { describe, expect, it } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';
import { ChromaSync } from '../../../src/services/sync/ChromaSync.js';
import { ChromaMcpManager } from '../../../src/services/sync/ChromaMcpManager.js';
import { SearchManager } from '../../../src/services/worker/SearchManager.js';
import { SearchRoutes } from '../../../src/services/worker/http/routes/SearchRoutes.js';
import { FormattingService } from '../../../src/services/worker/FormattingService.js';
import { TimelineService } from '../../../src/services/worker/TimelineService.js';
import { ChromaSearchStrategy } from '../../../src/services/worker/search/strategies/ChromaSearchStrategy.js';

type Metadata = { sqlite_id: number; doc_type: string; project: string; created_at_epoch: number };

function matches(where: any, meta: Metadata): boolean {
  if (!where) return true;
  if (where.$and) return where.$and.every((part: any) => matches(part, meta));
  if (where.$or) return where.$or.some((part: any) => matches(part, meta));
  return Object.entries(where).every(([key, value]: [string, any]) =>
    value?.$in ? value.$in.includes(meta[key as keyof Metadata]) : meta[key as keyof Metadata] === value);
}

describe('semantic row-id fallback with multiple fragments per memory', () => {
  for (const pipeline of ['http', 'strategy'] as const) {
    it(`keeps summaries already present in the narrowed window through ${pipeline}`, async () => {
      const store = new SessionStore(':memory:');
      const docs: Array<{ id: string; metadata: Metadata }> = [];
      const observations: number[] = [];
      const summaries: number[] = [];
      const now = Date.now();
      for (const project of ['fragment-scope', 'other-project']) {
        const session = store.createSDKSession(project, project, 'a question');
        store.ensureMemorySessionIdRegistered(session, `memory-${project}`);
        // A large project crowds the scoped rows out of the initial global
        // window. The narrowed window then holds every scoped row: 60 * 30
        // observation facts plus 20 summary requests, under its 2,000 slots.
        const rowCount = project === 'other-project' ? 50 : 60;
        const factCount = project === 'other-project' ? 40 : 30;
        for (let n = 0; n < rowCount; n++) {
          const facts = Array.from({ length: factCount }, (_, i) => `Finding ${n}, detail ${i}`);
          const id = store.storeObservation(`memory-${project}`, project, {
            type: 'discovery', title: `${project} finding ${n}`, subtitle: null,
            narrative: null, facts, concepts: [], files_read: [], files_modified: [],
          }, 1, 0, now).id;
          if (project === 'fragment-scope') observations.push(id);
          const fragments = facts.map((_, i) => ({ id: `obs_${id}_fact_${i}`,
            metadata: { sqlite_id: id, doc_type: 'observation', project, created_at_epoch: now } }));
          if (project === 'other-project') docs.unshift(...fragments);
          else docs.push(...fragments);
        }
      }
      for (let n = 0; n < 20; n++) {
        const id = store.storeSummary('memory-fragment-scope', 'fragment-scope', {
          request: `Summary ${n}`, investigated: null, learned: null, completed: null,
          next_steps: null, notes: null,
        }, n + 1, 0, now).id;
        summaries.push(id);
        docs.push({ id: `summary_${id}_request`, metadata: {
          sqlite_id: id, doc_type: 'session_summary', project: 'fragment-scope', created_at_epoch: now,
        } });
      }

      const transport = ChromaMcpManager.getInstance();
      const originalCallTool = transport.callTool;
      const calls: any[] = [];
      let server: Server | undefined;
      try {
        // Only the external Chroma transport is replaced. SQLite scope
        // resolution, fragment deduplication, hydration and pagination run.
        transport.callTool = async (name: string, args: any) => {
          if (name === 'chroma_create_collection') return {};
          if (name !== 'chroma_query_documents') throw new Error(`Unexpected tool ${name}`);
          calls.push(args);
          const hits = docs.filter(doc => matches(args.where, doc.metadata)).slice(0, args.n_results);
          return { ids: [hits.map(doc => doc.id)], metadatas: [hits.map(doc => doc.metadata)],
            distances: [hits.map((_, i) => i / 10000)] };
        };
        const chroma = new ChromaSync('fragment-scope');
        let result: any;
        if (pipeline === 'http') {
          const manager = new SearchManager(new SessionSearch(store.db), store, chroma,
            new FormattingService(), new TimelineService());
          const app = express();
          new SearchRoutes(manager).setupRoutes(app);
          server = app.listen(0, '127.0.0.1');
          if (!server.listening) await new Promise<void>(resolve => server!.once('listening', resolve));
          const address = server.address();
          if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
          const response = await fetch(`http://127.0.0.1:${address.port}/api/search?` + new URLSearchParams({
            query: 'semantic paraphrase', project: 'fragment-scope', type: 'observations,sessions',
            orderBy: 'relevance', limit: '20', format: 'json',
          }));
          expect(response.status).toBe(200);
          result = await response.json();
        } else {
          result = (await new ChromaSearchStrategy(chroma, store).search({
            query: 'semantic paraphrase', project: 'fragment-scope', searchType: ['observations', 'sessions'],
            orderBy: 'relevance', limit: 20,
          })).results;
        }
        expect(result.sessions.map((row: { id: number }) => row.id)).toEqual(summaries);
        expect(result.observations.map((row: { id: number }) => row.id)).toEqual(observations.slice(0, 20));
        // The first global query and one scoped query already contain the
        // complete answer; no larger window or plain-filter retry is needed.
        expect(calls).toHaveLength(2);
        expect(calls[0].where).toBeUndefined();
        expect(Object.keys(calls[1].where)).toEqual(['sqlite_id']);
      } finally {
        transport.callTool = originalCallTool;
        server?.closeAllConnections();
        if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
        store.close();
      }
    });
  }
});
