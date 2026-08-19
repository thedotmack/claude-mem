import { Database } from 'bun:sqlite';
import { VectorIndex } from '../../src/services/vector/VectorIndex.js';
import { LocalEmbedder } from '../../src/services/vector/LocalEmbedder.js';

const db = new Database(':memory:');
db.run('PRAGMA foreign_keys = ON');
db.run(`CREATE TABLE observations (
  id INTEGER PRIMARY KEY, project TEXT, merged_into_project TEXT, platform_source TEXT
)`);
const seedRow = db.prepare('INSERT INTO observations (id,project,merged_into_project,platform_source) VALUES (?,?,?,?)');
seedRow.run(1, 'alpha', null, 'claude');
seedRow.run(2, 'alpha', null, 'claude');
seedRow.run(3, 'beta',  null, 'claude');

const index = new VectorIndex(db, new LocalEmbedder());
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
};

const wrote = await index.upsert('observation', [
  { docId: 'obs_1_n', sqliteId: 1, fieldType: 'narrative', factIndex: null,
    text: 'two agents wrote the same results file at once and one finding was lost' },
  { docId: 'obs_2_n', sqliteId: 2, fieldType: 'narrative', factIndex: null,
    text: 'the CSS gradient on the landing page header needed adjusting' },
  { docId: 'obs_3_n', sqliteId: 3, fieldType: 'narrative', factIndex: null,
    text: 'concurrent writers clobbered a shared store during a migration' },
]);
check('upsert writes all three', wrote === 3, `wrote=${wrote}`);

// 1. semantic relevance — the concurrency doc must beat the CSS doc
const hits = await index.query({ text: 'lost update when two writers race', kinds: ['observation'], limit: 3 });
check('nearest hit is semantically right', hits[0].docId === 'obs_1_n', `got ${hits[0].docId} @ ${hits[0].score.toFixed(3)}`);
check('irrelevant doc ranks last', hits[hits.length-1].docId === 'obs_2_n', `got ${hits[hits.length-1].docId}`);

// 2. project scoping — the thing buildWhereFilter did
const scoped = await index.query({ text: 'concurrent writers', kinds: ['observation'], project: 'beta', limit: 5 });
check('project scope excludes other projects', scoped.length === 1 && scoped[0].sqliteId === 3, `n=${scoped.length}`);

// 3. content-hash skip — re-upserting identical text must not re-embed
const again = await index.upsert('observation', [
  { docId: 'obs_1_n', sqliteId: 1, fieldType: 'narrative', factIndex: null,
    text: 'two agents wrote the same results file at once and one finding was lost' },
]);
check('unchanged text is not re-embedded', again === 0, `re-embedded=${again}`);

// 4. changed text IS re-embedded
const edited = await index.upsert('observation', [
  { docId: 'obs_1_n', sqliteId: 1, fieldType: 'narrative', factIndex: null, text: 'completely different content now' },
]);
check('edited text is re-embedded', edited === 1, `re-embedded=${edited}`);

// 5. CASCADE — deleting the parent row must remove its vectors
db.run('DELETE FROM observations WHERE id = 3');
check('vectors cascade with parent row', index.countIndexed('observation') === 2, `remaining=${index.countIndexed('observation')}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
