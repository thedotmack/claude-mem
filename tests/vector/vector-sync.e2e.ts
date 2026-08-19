import { Database } from 'bun:sqlite';
import { VectorIndex } from '../../src/services/vector/VectorIndex.js';
import { VectorSync } from '../../src/services/vector/VectorSync.js';
import { LocalEmbedder } from '../../src/services/vector/LocalEmbedder.js';

const db = new Database(':memory:');
db.run('PRAGMA foreign_keys = ON');
// Real column layout: scope lives on the parent rows / sdk_sessions, never
// denormalised onto the vector rows.
db.run(`CREATE TABLE sdk_sessions (id INTEGER PRIMARY KEY, content_session_id TEXT, memory_session_id TEXT, project TEXT, platform_source TEXT)`);
db.run(`CREATE TABLE observations (id INTEGER PRIMARY KEY, memory_session_id TEXT, project TEXT, merged_into_project TEXT, created_at_epoch INTEGER)`);
db.run(`CREATE TABLE session_summaries (id INTEGER PRIMARY KEY, memory_session_id TEXT, project TEXT, merged_into_project TEXT, created_at_epoch INTEGER)`);
db.run(`CREATE TABLE user_prompts (id INTEGER PRIMARY KEY, content_session_id TEXT, created_at_epoch INTEGER)`);
db.prepare('INSERT INTO sdk_sessions VALUES (?,?,?,?,?)').run(1, 'cs-1', 'sess-1', 'alpha', 'claude');
db.prepare('INSERT INTO observations VALUES (?,?,?,?,?)').run(7, 'sess-1', 'alpha', null, Date.now());
db.prepare('INSERT INTO session_summaries VALUES (?,?,?,?,?)').run(9, 'sess-1', 'alpha', null, Date.now());

const index = new VectorIndex(db, new LocalEmbedder());
const sync = new VectorSync(index);
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, x = '') => { ok ? pass++ : fail++; console.log(`${ok?'PASS':'FAIL'}  ${n}${x?' — '+x:''}`); };

await sync.syncObservation(7, 'sess-1', 'alpha', {
  type: 'discovery', title: 'race', subtitle: null,
  facts: ['two writers hit the same row', 'the later write won silently'],
  narrative: 'a concurrent write clobbered a peer update',
  concepts: [], files_read: [], files_modified: [],
}, 1, Date.now(), 'claude');

// narrative + 2 facts = 3 documents
check('observation fans out to 3 docs', index.countIndexed('observation') === 3, `n=${index.countIndexed('observation')}`);

// doc ids must stay byte-identical to the Chroma scheme
const ids = (db.prepare('SELECT doc_id FROM vec_observation_docs ORDER BY doc_id').all() as {doc_id:string}[]).map(r=>r.doc_id);
check('doc ids match the Chroma scheme',
  ids.join(',') === 'obs_7_fact_0,obs_7_fact_1,obs_7_narrative', ids.join(','));

// idempotent re-sync must not re-embed
const before = index.countIndexed('observation');
await sync.syncObservation(7, 'sess-1', 'alpha', {
  type: 'discovery', title: 'race', subtitle: null,
  facts: ['two writers hit the same row', 'the later write won silently'],
  narrative: 'a concurrent write clobbered a peer update',
  concepts: [], files_read: [], files_modified: [],
}, 1, Date.now(), 'claude');
check('re-sync is idempotent', index.countIndexed('observation') === before, `n=${index.countIndexed('observation')}`);

await sync.syncSummary(9, 'sess-1', 'alpha', {
  request: 'fix the lost update', investigated: 'traced the write path',
  learned: null, completed: null, next_steps: null, notes: null,
} as any, 1, Date.now(), 'claude');
check('summary indexes only populated fields', index.countIndexed('summary') === 2, `n=${index.countIndexed('summary')}`);

// the written docs must actually be retrievable
const hits = await index.query({ text: 'concurrent write overwrote another change', kinds: ['observation'], project: 'alpha', limit: 3 });
check('written docs are retrievable', hits.length > 0 && hits[0].sqliteId === 7, `top=${hits[0]?.docId}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
