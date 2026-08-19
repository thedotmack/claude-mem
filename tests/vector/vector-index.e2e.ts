import { Database } from 'bun:sqlite';
import { VectorIndex } from '../../src/services/vector/VectorIndex.js';
import { LocalEmbedder } from '../../src/services/vector/LocalEmbedder.js';

/**
 * Schema here mirrors the REAL claude-mem tables, including where the scoping
 * columns actually live: observations/session_summaries carry `project`
 * themselves, user_prompts carry neither and reach project + platform_source
 * only through sdk_sessions.content_session_id. An earlier version of this test
 * invented a flat schema where every table had project and platform_source, and
 * it passed while the query was wrong for prompts.
 */
const db = new Database(':memory:');
db.run('PRAGMA foreign_keys = ON');
db.run(`CREATE TABLE sdk_sessions (
  id INTEGER PRIMARY KEY, content_session_id TEXT, memory_session_id TEXT,
  project TEXT, platform_source TEXT)`);
db.run(`CREATE TABLE observations (
  id INTEGER PRIMARY KEY, memory_session_id TEXT, project TEXT, merged_into_project TEXT, created_at_epoch INTEGER)`);
db.run(`CREATE TABLE session_summaries (
  id INTEGER PRIMARY KEY, memory_session_id TEXT, project TEXT, merged_into_project TEXT, created_at_epoch INTEGER)`);
db.run(`CREATE TABLE user_prompts (
  id INTEGER PRIMARY KEY, content_session_id TEXT, prompt_text TEXT, created_at_epoch INTEGER)`);

db.prepare('INSERT INTO sdk_sessions VALUES (?,?,?,?,?)').run(1, 'cs-a', 'ms-a', 'alpha', 'claude');
db.prepare('INSERT INTO sdk_sessions VALUES (?,?,?,?,?)').run(2, 'cs-b', 'ms-b', 'beta', 'codex');
db.prepare('INSERT INTO observations VALUES (?,?,?,?,?)').run(1, 'ms-a', 'alpha', null, Date.now());
db.prepare('INSERT INTO observations VALUES (?,?,?,?,?)').run(2, 'ms-a', 'alpha', null, Date.now());
db.prepare('INSERT INTO observations VALUES (?,?,?,?,?)').run(3, 'ms-b', 'beta', null, Date.now());
// a row remapped into alpha — must be reachable when scoping by alpha
db.prepare('INSERT INTO observations VALUES (?,?,?,?,?)').run(4, 'ms-b', 'legacy', 'alpha', Date.now());
db.prepare('INSERT INTO user_prompts VALUES (?,?,?,?)').run(10, 'cs-a', 'p', Date.now());

const index = new VectorIndex(db, new LocalEmbedder());
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, x = '') => { ok ? pass++ : fail++; console.log(`${ok?'PASS':'FAIL'}  ${n}${x?' — '+x:''}`); };

const wrote = await index.upsert('observation', [
  { docId:'obs_1_n', sqliteId:1, fieldType:'narrative', factIndex:null, text:'two agents wrote the same results file at once and one finding was lost' },
  { docId:'obs_2_n', sqliteId:2, fieldType:'narrative', factIndex:null, text:'the CSS gradient on the landing page header needed adjusting' },
  { docId:'obs_3_n', sqliteId:3, fieldType:'narrative', factIndex:null, text:'concurrent writers clobbered a shared store during a migration' },
  { docId:'obs_4_n', sqliteId:4, fieldType:'narrative', factIndex:null, text:'a remapped project row about racing writes' },
]);
check('upsert writes all four', wrote === 4, `wrote=${wrote}`);

const hits = await index.query({ text:'lost update when two writers race', kinds:['observation'], limit:4 });
check('nearest hit is semantically right', hits[0].docId === 'obs_1_n', `${hits[0].docId} @ ${hits[0].score.toFixed(3)}`);
check('irrelevant doc ranks last', hits[hits.length-1].docId === 'obs_2_n', hits[hits.length-1].docId);

const beta = await index.query({ text:'concurrent writers', kinds:['observation'], project:'beta', limit:5 });
check('project scope excludes other projects', beta.length === 1 && beta[0].sqliteId === 3, `n=${beta.length}`);

// merged_into_project must be honoured, as the Chroma $or filter did
const alpha = await index.query({ text:'racing writes', kinds:['observation'], project:'alpha', limit:9 });
check('merged_into_project is honoured', alpha.some(h => h.sqliteId === 4), `ids=${alpha.map(h=>h.sqliteId).join(',')}`);

// platform_source lives on sdk_sessions, reached by JOIN — not on observations
const byPlatform = await index.query({ text:'writers', kinds:['observation'], platformSource:'codex', limit:9 });
check('platform_source scopes via sdk_sessions join',
  byPlatform.every(h => h.sqliteId === 3 || h.sqliteId === 4), `ids=${byPlatform.map(h=>h.sqliteId).join(',')}`);

// prompts reach project only through content_session_id -> sdk_sessions
await index.upsert('prompt', [{ docId:'pr_10', sqliteId:10, fieldType:'prompt_text', factIndex:null, text:'how do I stop two agents overwriting each other' }]);
const prompts = await index.query({ text:'agents overwriting', kinds:['prompt'], project:'alpha', limit:3 });
check('prompt scoping joins through sdk_sessions', prompts.length === 1 && prompts[0].sqliteId === 10, `n=${prompts.length}`);
const promptsBeta = await index.query({ text:'agents overwriting', kinds:['prompt'], project:'beta', limit:3 });
check('prompt excluded from wrong project', promptsBeta.length === 0, `n=${promptsBeta.length}`);

const again = await index.upsert('observation', [
  { docId:'obs_1_n', sqliteId:1, fieldType:'narrative', factIndex:null, text:'two agents wrote the same results file at once and one finding was lost' },
]);
check('unchanged text is not re-embedded', again === 0, `re-embedded=${again}`);

db.run('DELETE FROM observations WHERE id = 3');
check('vectors cascade with parent row', index.countIndexed('observation') === 3, `remaining=${index.countIndexed('observation')}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
