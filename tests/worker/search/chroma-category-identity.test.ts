import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';
import { SearchOrchestrator } from '../../../src/services/worker/search/SearchOrchestrator.js';
import { ChromaSync } from '../../../src/services/sync/ChromaSync.js';
import { CorpusBuilder } from '../../../src/services/worker/knowledge/CorpusBuilder.js';
import type { CorpusStore } from '../../../src/services/worker/knowledge/CorpusStore.js';

let store: SessionStore | undefined;
let search: SessionSearch | undefined;
let fixtureDir: string;
let dbPath: string;
beforeEach(() => { fixtureDir = mkdtempSync(join(tmpdir(), 'chroma-identities-')); dbPath = join(fixtureDir, 'fixture.db'); });
afterEach(() => { search?.close(); store?.close(); rmSync(fixtureDir, { recursive: true, force: true }); });

describe('semantic search identities across SQLite tables', () => {
  it('keeps matching observations in a corpus when prompts share their row ID', async () => {
    store = new SessionStore(dbPath);
    const sessionId = store.createSDKSession('host-session', 'project', 'prompt');
    store.updateMemorySessionId(sessionId, 'observer-session');
    const epoch = Date.now();
    const observation = store.storeObservation('observer-session', 'project', {
      type: 'discovery', title: 'A semantic-only finding', subtitle: null,
      narrative: 'A meaning-related fact', facts: [], concepts: [], files_read: [], files_modified: [],
    }, 1, 0, epoch);
    const prompt = store.db.prepare(`INSERT INTO user_prompts
      (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (?, ?, 1, ?, ?, ?) RETURNING id`).get(sessionId, 'host-session', 'Related opening task', new Date(epoch).toISOString(), epoch) as { id: number };
    expect(prompt.id).toBe(observation.id);
    // Use production Chroma normalization: its numeric IDs are deliberately table-local,
    // and its metadata remains aligned after deduplicating each document category.
    const chroma = Object.create(ChromaSync.prototype) as ChromaSync;
    const results = (chroma as any).deduplicateQueryResults({
      ids: [[`prompt_${prompt.id}`, `obs_${observation.id}_narrative`, `obs_${observation.id}_fact_0`]],
      metadatas: [[
        { sqlite_id: prompt.id, doc_type: 'user_prompt', created_at_epoch: epoch },
        { sqlite_id: observation.id, doc_type: 'observation', created_at_epoch: epoch },
        { sqlite_id: observation.id, doc_type: 'observation', created_at_epoch: epoch },
      ]], distances: [[0.1, 0.2, 0.3]],
    });
    chroma.queryChroma = async () => results;
    search = new SessionSearch(dbPath);
    const orchestrator = new SearchOrchestrator(search, store, chroma);
    const result = await orchestrator.search({ query: 'unindexed semantic query', project: 'project' });
    expect(result.results.prompts.map(row => row.id)).toEqual([prompt.id]);
    expect(result.results.observations.map(row => row.id)).toEqual([observation.id]);
    const builder = new CorpusBuilder(store, orchestrator, {} as CorpusStore);
    const corpus = await builder.build('semantic', 'Meaning search', { project: 'project', query: 'unindexed semantic query' }, { writeFile: false });
    expect(corpus.observations.map(row => row.id)).toEqual([observation.id]);
  });

  it('applies recency to each category even when the row IDs coincide', async () => {
    store = new SessionStore(dbPath);
    const sessionId = store.createSDKSession('host-session', 'project', 'prompt');
    store.updateMemorySessionId(sessionId, 'observer-session');
    const epoch = Date.now();
    const observation = store.storeObservation('observer-session', 'project', {
      type: 'discovery', title: 'A current semantic finding', subtitle: null,
      narrative: 'Meaning-related fact', facts: [], concepts: [], files_read: [], files_modified: [],
    }, 1, 0, epoch);
    const chroma = { queryChroma: async () => ({ ids: [observation.id, observation.id], distances: [0.1, 0.2], metadatas: [
      { sqlite_id: observation.id, doc_type: 'user_prompt', created_at_epoch: epoch - 180 * 86400000 },
      { sqlite_id: observation.id, doc_type: 'observation', created_at_epoch: epoch },
    ] }) } as unknown as ChromaSync;
    search = new SessionSearch(dbPath);
    const result = await new SearchOrchestrator(search, store, chroma).search({ query: 'unindexed semantic query', project: 'project' });
    expect(result.results.observations.map(row => row.id)).toEqual([observation.id]);
  });
});
