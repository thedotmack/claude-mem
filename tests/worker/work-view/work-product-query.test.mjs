import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { readProductRecords } from '../../../src/services/work-view/work-product.mjs';
import { readAgentRecords } from '../../../src/services/work-view/agent-view.mjs';

function fixture(indexes = 'time') {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE tool_uses (id INTEGER PRIMARY KEY, session_db_id INTEGER, prompt_number INTEGER,
      tool_name TEXT, tool_input TEXT, tool_response TEXT, created_at_epoch INTEGER);
    CREATE TABLE observations (id INTEGER PRIMARY KEY, memory_session_id TEXT, prompt_number INTEGER,
      files_modified TEXT, created_at_epoch INTEGER);
    CREATE TABLE deliverables (id INTEGER PRIMARY KEY, project TEXT, content_session_id TEXT,
      platform_source TEXT, title TEXT, kind TEXT, source_path TEXT, bucket_path TEXT, created_at_epoch INTEGER);
  `);
  if (indexes === 'time') db.exec(`
    CREATE INDEX idx_tool_uses_created_at_epoch ON tool_uses(created_at_epoch);
    CREATE INDEX idx_observations_created ON observations(created_at_epoch DESC);
  `);
  if (indexes === 'wrong-column') db.exec(`
    CREATE INDEX idx_tool_uses_created_at_epoch ON tool_uses(tool_name);
    CREATE INDEX idx_observations_created ON observations(files_modified);
  `);
  if (indexes === 'partial') db.exec(`
    CREATE INDEX idx_tool_uses_created_at_epoch ON tool_uses(created_at_epoch) WHERE tool_name = 'Bash';
    CREATE INDEX idx_observations_created ON observations(created_at_epoch) WHERE prompt_number = 1;
  `);
  const call = db.prepare('INSERT INTO tool_uses VALUES (?, 1, 1, ?, ?, ?, ?)');
  const oldObservation = db.prepare("INSERT INTO observations VALUES (?, 'old', 1, '[]', 50)");
  db.transaction(() => {
    // High IDs are older imported history; timestamps must filter without
    // changing the final ID-descending ordering of either product lane.
    for (let id = 100; id < 10_100; id++) {
      call.run(id, 'Read', '{}', '{}', 50);
      oldObservation.run(id);
    }
    call.run(1, 'Artifact', '{}', '{"url":"https://example.com/one"}', 300);
    call.run(6, 'mcp__sites__save_version_and_deploy', '{}', '{}', 200);
    call.run(3, 'Bash', '{"command":"git push"}', '{}', 400);
    call.run(7, 'Bash', '{"command":"git commit"}', '{}', 150);
    call.run(8, 'Artifact', '{}', '{}', 99);
    call.run(9, 'Bash', '{"command":"echo quiet"}', '{}', 500);
  })();
  db.exec(`INSERT INTO observations VALUES
    (2, 'm', 1, '["/work/second.png"]', 300),
    (4, 'm', 1, '["/work/fourth.pdf"]', 100),
    (20, 'm', 1, '["/work/old.png"]', 99),
    (30, 'm', 1, '["/work/source.ts"]', 500);
    INSERT INTO deliverables VALUES (1, 'p', 'c', 'claude', 'report', 'page', '/source', '/bucket', 120);
  `);
  return db;
}

function read(db, limit = 2000, optimize = true) {
  const statements = [];
  const result = readProductRecords((sql, params) => {
    statements.push({ sql, plan: db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map(row => row.detail) });
    return db.prepare(sql).all(...params);
  }, 100, limit, optimize ? { database: db } : {});
  return { result, statements };
}

test('product discovery uses existing time indexes with identical rows and ID order', () => {
  const db = fixture();
  try {
    const baseline = read(db, 2000, false);
    const optimized = read(db);
    assert.deepEqual(optimized.result, baseline.result);
    assert.deepEqual(optimized.result.productCalls.map(row => row.id), [6, 1, 7, 3]);
    assert.deepEqual(optimized.result.productObservations.map(row => row.id), [4, 2]);
    assert.equal(optimized.result.productDeliverables.length, 1);
    for (const query of optimized.statements.slice(0, 3)) {
      assert.match(query.sql, /INDEXED BY idx_(tool_uses_created_at_epoch|observations_created)/);
      assert.ok(query.plan.some(detail => /SEARCH .* USING INDEX .*created.*created_at_epoch>/.test(detail)), query.plan.join('\n'));
    }
  } finally { db.close(); }
});

test('publisher and Git discovery retain separate limits after time-index selection', () => {
  const db = fixture();
  try {
    assert.deepEqual(read(db, 1).result, read(db, 1, false).result);
    assert.deepEqual(read(db, 1).result.productCalls.map(row => row.id), [6, 7]);
    assert.deepEqual(read(db, 1).result.productObservations.map(row => row.id), [4]);
  } finally { db.close(); }
});

test('unbounded history retains the planner choice instead of forcing a time-index sort', () => {
  const db = fixture();
  try {
    const statements = [];
    const fetch = (sql, params) => { statements.push(sql); return db.prepare(sql).all(...params); };
    const result = readProductRecords(fetch, 0, 1, { database: db });
    assert.deepEqual(result, readProductRecords((sql, params) => db.prepare(sql).all(...params), 0, 1));
    assert.ok(statements.every(sql => !sql.includes('INDEXED BY')));
  } finally { db.close(); }
});

for (const rows of [3000, 50_000, 200_000]) {
  for (const dense of ['publisher', 'git']) test(`broad positive cutoffs preserve the ${dense} planner on ${rows} dense rows`, () => {
    const db = fixture();
    try {
      const toolName = dense === 'publisher' ? 'Artifact' : 'Bash';
      const toolInput = dense === 'publisher' ? '{}' : '{"command":"git commit"}';
      const insert = db.prepare(`INSERT INTO tool_uses VALUES (?, 1, 1, ?, ?, '{}', 200)`);
      db.transaction(() => {
        for (let id = 20_000; id < rows + 20_000; id++) insert.run(id, toolName, toolInput);
      })();
      const statements = [];
      const fetch = (sql, params) => { statements.push(sql); return db.prepare(sql).all(...params); };
      const cutoff = rows === 3000 ? 100 : 1;
      const optimized = readProductRecords(fetch, cutoff, 2000, { database: db });
      const baseline = readProductRecords((sql, params) => db.prepare(sql).all(...params), cutoff, 2000);
      assert.deepEqual(optimized, baseline);
      assert.ok(!statements[dense === 'publisher' ? 0 : 1].includes('INDEXED BY'));
      assert.equal(optimized.productCalls.filter(row => row.tool_name === toolName).length, 2000);
    } finally { db.close(); }
  });
}

for (const dense of ['publisher', 'git']) {
  test(`dense ${dense} activity does not disable the other sparse lane's time index`, () => {
    const db = fixture();
    try {
      const insert = db.prepare(`INSERT INTO tool_uses VALUES (?, 1, 1, ?, ?, '{}', 200)`);
      db.transaction(() => {
        for (let id = 20_000; id < 20_128; id++) {
          insert.run(id, dense === 'publisher' ? 'Artifact' : 'Bash', dense === 'publisher' ? '{}' : '{"command":"git commit"}');
        }
      })();
      const denseIndex = dense === 'publisher' ? 0 : 1;
      const sparseIndex = dense === 'publisher' ? 1 : 0;
      const result = read(db);
      assert.deepEqual(result.result, read(db, 2000, false).result);
      assert.ok(!result.statements[denseIndex].sql.includes('INDEXED BY'));
      assert.match(result.statements[sparseIndex].sql, /INDEXED BY idx_tool_uses_created_at_epoch/);
      assert.ok(result.statements[sparseIndex].plan.some(detail => /SEARCH .* USING INDEX .*created.*created_at_epoch>/.test(detail)));
    } finally { db.close(); }
  });
}

test('a bounded sparse range larger than the result limit still uses its time index', () => {
  const db = fixture();
  try {
    const insert = db.prepare(`INSERT INTO tool_uses VALUES (?, 1, 1, 'Read', '{}', '{}', 200)`);
    db.transaction(() => {
      for (let id = 20_000; id < 26_000; id++) insert.run(id);
    })();
    const result = read(db);
    assert.match(result.statements[0].sql, /INDEXED BY idx_tool_uses_created_at_epoch/);
    assert.deepEqual(result.result, read(db, 2000, false).result);
  } finally { db.close(); }
});

test('sparse recent activity beyond 8192 candidates does not fall back to historical payload scans', () => {
  const db = fixture();
  try {
    const insert = db.prepare(`INSERT INTO tool_uses VALUES (?, 1, 1, 'Read', '{}', '{}', 200)`);
    db.transaction(() => {
      for (let id = 20_000; id < 32_000; id++) insert.run(id);
    })();
    const result = read(db);
    assert.match(result.statements[0].sql, /INDEXED BY idx_tool_uses_created_at_epoch/);
    assert.match(result.statements[1].sql, /INDEXED BY idx_tool_uses_created_at_epoch/);
    assert.deepEqual(result.result, read(db, 2000, false).result);
  } finally { db.close(); }
});

for (const dense of ['publisher', 'git']) test(`range selectivity for ${dense} is rechecked after writes on the same connection`, () => {
  const db = fixture();
  try {
    assert.ok(read(db).statements.slice(0, 2).every(query => query.sql.includes('INDEXED BY')));
    const insert = db.prepare(`INSERT INTO tool_uses VALUES (?, 1, 1, ?, ?, '{}', 200)`);
    db.transaction(() => {
      for (let id = 20_000; id < 22_001; id++) {
        insert.run(id, dense === 'publisher' ? 'Artifact' : 'Bash', dense === 'publisher' ? '{}' : '{"command":"git commit"}');
      }
    })();
    const result = read(db);
    assert.ok(!result.statements[dense === 'publisher' ? 0 : 1].sql.includes('INDEXED BY'));
    assert.ok(result.statements[dense === 'publisher' ? 1 : 0].sql.includes('INDEXED BY'));
    assert.deepEqual(result.result, read(db, 2000, false).result);
  } finally { db.close(); }
});

for (const indexes of ['none', 'wrong-column', 'partial']) {
  test(`product discovery falls back without an applicable time index (${indexes})`, () => {
    const db = fixture(indexes);
    try {
      const optimized = read(db);
      assert.deepEqual(optimized.result, read(db, 2000, false).result);
      assert.ok(optimized.statements.every(({ sql }) => !sql.includes('INDEXED BY')));
    } finally { db.close(); }
  });
}

test('index capabilities are inspected once per database connection', () => {
  const db = fixture();
  let metadataReads = 0;
  const connection = { prepare(sql) {
    if (sql.startsWith('PRAGMA index_')) metadataReads++;
    return db.prepare(sql);
  } };
  const fetch = (sql, params) => db.prepare(sql).all(...params);
  try {
    readProductRecords(fetch, 100, 2000, { database: connection });
    assert.equal(metadataReads, 4);
    readProductRecords(fetch, 100, 2000, { database: connection });
    assert.equal(metadataReads, 4);
  } finally { db.close(); }
});

test('old empty databases retain missing-table tolerance and real errors propagate', () => {
  const db = new Database(':memory:');
  try {
    const records = readAgentRecords(db);
    assert.deepEqual(records.productCalls, []);
    assert.deepEqual(records.productObservations, []);
    assert.deepEqual(records.productDeliverables, []);
    assert.throws(() => readProductRecords(() => { throw new Error('database disk image is malformed'); }, 0, 10, { database: db }), /malformed/);
    assert.throws(() => readProductRecords(() => [], 100, 10, { database: { prepare() { throw new Error('database is locked'); } } }), /locked/);
  } finally { db.close(); }
});

test('indexed legacy tables missing product columns retain missing-column tolerance', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE observations (id INTEGER PRIMARY KEY, created_at_epoch INTEGER);
      CREATE INDEX idx_observations_created ON observations(created_at_epoch);`);
    const records = readAgentRecords(db, { workState: { lists: [{ stateUpdatedAtEpoch: 10, tasks: [] }] } });
    assert.deepEqual(records.productObservations, []);
  } finally { db.close(); }
});
