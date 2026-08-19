import { Database } from 'bun:sqlite';
import { VectorIndex } from '../../src/services/vector/VectorIndex.js';
import { VectorBackfill } from '../../src/services/vector/VectorBackfill.js';
import { LocalEmbedder } from '../../src/services/vector/LocalEmbedder.js';

const db = new Database(':memory:');
db.run('PRAGMA foreign_keys = ON');
db.run(`CREATE TABLE sdk_sessions (id INTEGER PRIMARY KEY, content_session_id TEXT, memory_session_id TEXT, project TEXT, platform_source TEXT)`);
db.run(`CREATE TABLE observations (id INTEGER PRIMARY KEY, memory_session_id TEXT, project TEXT, merged_into_project TEXT, narrative TEXT, facts TEXT, created_at_epoch INTEGER)`);
db.run(`CREATE TABLE session_summaries (id INTEGER PRIMARY KEY, memory_session_id TEXT, project TEXT, merged_into_project TEXT, request TEXT, learned TEXT, created_at_epoch INTEGER)`);
db.run(`CREATE TABLE user_prompts (id INTEGER PRIMARY KEY, content_session_id TEXT, prompt_text TEXT, created_at_epoch INTEGER)`);
db.prepare('INSERT INTO sdk_sessions VALUES (?,?,?,?,?)').run(1,'cs-1','ms-1','alpha','claude');

// A pre-existing corpus, as an upgrading user would have.
const obs = db.prepare('INSERT INTO observations VALUES (?,?,?,?,?,?,?)');
for (let i = 1; i <= 5; i++) {
  obs.run(i, 'ms-1', 'alpha', null, `narrative number ${i} about shared state`, JSON.stringify([`fact a${i}`, `fact b${i}`]), Date.now());
}
// one row with malformed facts JSON — must not stall the whole backfill
obs.run(6, 'ms-1', 'alpha', null, 'narrative six', '{not valid json', Date.now());
db.prepare('INSERT INTO session_summaries VALUES (?,?,?,?,?,?,?)').run(1,'ms-1','alpha',null,'the request','the lesson',Date.now());
db.prepare('INSERT INTO user_prompts VALUES (?,?,?,?)').run(1,'cs-1','how do agents avoid clobbering',Date.now());

const index = new VectorIndex(db, new LocalEmbedder());
const backfill = new VectorBackfill(db, index);
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, x='') => { ok?pass++:fail++; console.log(`${ok?'PASS':'FAIL'}  ${n}${x?' — '+x:''}`); };

check('starts incomplete', !backfill.isComplete(index.modelId));

// drive to completion the way a caller on a timer would
let guard = 0;
while (!backfill.isComplete(index.modelId) && guard++ < 20) await backfill.runBatch();
check('reaches completion', backfill.isComplete(index.modelId), `passes=${guard}`);

// 5 rows x (1 narrative + 2 facts) + row 6 narrative only (bad JSON) = 16
check('observations fully embedded', index.countIndexed('observation') === 16, `n=${index.countIndexed('observation')}`);
check('malformed facts JSON did not stall the run', index.countIndexed('observation') > 0);
check('summaries embedded', index.countIndexed('summary') === 2, `n=${index.countIndexed('summary')}`);
check('prompts embedded', index.countIndexed('prompt') === 1, `n=${index.countIndexed('prompt')}`);

// resumable + idempotent: another pass must do nothing
const after = await backfill.runBatch();
check('completed backfill is a no-op', after.every(p => p.processed === 0 && p.remaining === 0));

// the backfilled corpus is actually searchable
const hits = await index.query({ text:'agents overwriting shared state', kinds:['observation','prompt'], project:'alpha', limit:3 });
check('backfilled corpus is searchable', hits.length > 0, `top=${hits[0]?.docId}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
