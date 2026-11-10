/** Synthetic, reproducible capacity probe. Never opens the user's memory database.
 * bun scripts/bench-tool-use-search.ts 2500
 * bun scripts/bench-tool-use-search.ts 139304
 * Reports stored bytes as well as rows; this is not a real-corpus qualification.
 */
import { Database } from 'bun:sqlite';
import { applySqliteConnectionPragmas } from '../src/services/sqlite/connection.js';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir, platform, arch } from 'node:os';
import path from 'node:path';
import { createToolUsesSchema, upsertToolUse } from '../src/services/sqlite/tool-uses.js';
import { configureToolUseIndexAsync, searchToolUses } from '../src/services/sqlite/tool-use-search.js';

const count = Number(process.argv[2] ?? 2500);
if (!Number.isSafeInteger(count) || count < 1 || count > 200_000) throw new Error('rows must be 1..200000');
const directory = mkdtempSync(path.join(tmpdir(), 'claude-mem-raw-search-bench-'));
const filename = path.join(directory, 'bench.db');
const db = new Database(filename);
const size = (file: string) => { try { return statSync(file).size; } catch { return 0; } };
const measured = <T>(run: () => T) => { const start = performance.now(); const result = run(); return { ms: performance.now() - start, result }; };
const latency = (query: string, project?: string) => {
  const times = Array.from({ length: 7 }, () => measured(() => searchToolUses(db, query, { project, limit: 5 })).ms).sort((a,b) => a-b);
  return { medianMs: times[3], maxMs: times[6] };
};
try {
  applySqliteConnectionPragmas(db);
  const checkpointsDisabled = process.argv.includes('--no-checkpoint');
  if (checkpointsDisabled) db.run('PRAGMA wal_autocheckpoint = 0');
  createToolUsesSchema(db);
  // Vary numeric identifiers and JSON/code-like words; a mixture of small and
  // large fields averaging ~11 KiB/row after the storage cap. Each tenth row also carries CJK text.
  const payload = (i: number) => Array.from({ length: i % 20 === 0 ? 1200 : i % 4 === 0 ? 300 : 90 }, (_, j) =>
    `module_${(i * 31 + j * 17) % 20000} path=src/service_${j % 53}.ts status=ready value=${i + j}`
  ).join('\n') + (i % 10 === 0 ? '\n数据库连接池恢复，worker 已重新启动' : '') + `\nunique_marker_${i}`;
  const write = (i: number, body = payload(i)) => upsertToolUse(db, {
    toolUseId: `tool-${i}`, contentSessionId: `session-${i % 100}`, project: `project-${i % 20}`,
    toolName: 'Bash', toolInput: JSON.stringify({ command: 'diagnose', row: i }), toolResponse: body,
  });
  const seed = measured(() => db.transaction(() => { for (let i=0; i<count; i++) write(i); })());
  const bytes = db.query('SELECT sum(length(CAST(tool_input AS BLOB)) + length(CAST(tool_response AS BLOB))) bytes FROM tool_uses').get();
  db.run('PRAGMA wal_checkpoint(TRUNCATE)');
  const beforeBytes = size(filename);
  const baselineBackup = path.join(directory, 'baseline-backup.db');
  const baselineBackupMs = measured(() => db.run('VACUUM INTO ?', [baselineBackup])).ms;
  const baselineBackupBytes = size(baselineBackup);
  rmSync(baselineBackup);
  let lastTick = performance.now(), maxBuildTimerGapMs = 0, buildTicks = 0, peakBuildWalBytes = 0;
  const timer = setInterval(() => { const now = performance.now(); maxBuildTimerGapMs = Math.max(maxBuildTimerGapMs, now-lastTick); lastTick = now; buildTicks++; peakBuildWalBytes = Math.max(peakBuildWalBytes, size(filename + '-wal')); }, 1);
  const buildStart = performance.now();
  await configureToolUseIndexAsync(db, true);
  clearInterval(timer);
  const build = { ms: performance.now() - buildStart };
  const buildWalBytes = size(filename + '-wal');
  db.run('PRAGMA wal_checkpoint(TRUNCATE)');
  const indexedBytes = size(filename);
  const indexTables = db.query("SELECT name, sum(pgsize) AS bytes FROM dbstat WHERE name LIKE 'tool_uses_fts%' GROUP BY name").all();
  const reads = {
    rareFts: latency(`unique_marker_${count - 1}`),
    scopedFts: latency('status ready', 'project-1'),
    cjkHit: latency('worker 连接池', 'project-0'),
    cjkMiss: latency('不存在的查询标记'),
    scopedCjkMiss: latency('不存在的查询标记', 'project-1'),
  };
  const mutations = {
    insert100: measured(() => db.transaction(() => { for(let i=count; i<count+100; i++) write(i); })()).ms,
    identicalReplay100: measured(() => db.transaction(() => { for(let i=count; i<count+100; i++) write(i); })()).ms,
    changedResponse100: measured(() => db.transaction(() => { for(let i=count; i<count+100; i++) write(i, 'changed response replacement'); })()).ms,
    delete100: measured(() => db.run('DELETE FROM tool_uses WHERE id > ?', [count])).ms,
  };
  const backup = path.join(directory, 'backup.db');
  const backupMs = measured(() => db.run('VACUUM INTO ?', [backup])).ms;
  db.run("INSERT INTO tool_uses_fts(tool_uses_fts, rank) VALUES('integrity-check', 1)");
  console.log(JSON.stringify({ synthetic: true, bun: Bun.version, platform: platform(), arch: arch(), rows: count, checkpointsDisabled,
    bytes, seedMs: seed.ms, beforeBytes, baselineBackupMs, baselineBackupBytes, indexedBytes, indexTables, indexGrowthBytes: indexedBytes-beforeBytes,
    buildMs: build.ms, maxBuildTimerGapMs, buildTicks, peakBuildWalBytes, buildWalBytes, reads, mutations, backupMs, backupBytes: size(backup),
  }, null, 2));
} finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
