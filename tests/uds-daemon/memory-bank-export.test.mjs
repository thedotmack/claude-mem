import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Database } from 'bun:sqlite';

const HERE = import.meta.dir;
const EXPORTER = join(HERE, '..', 'src', 'cli', 'memory-bank-export.mjs');

function seedDb(dbPath, project) {
  const db = new Database(dbPath, { create: true });
  db.run(`CREATE TABLE observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_session_id TEXT NOT NULL,
    project TEXT NOT NULL,
    text TEXT,
    type TEXT NOT NULL,
    title TEXT,
    subtitle TEXT,
    narrative TEXT,
    created_at TEXT NOT NULL,
    created_at_epoch INTEGER NOT NULL
  )`);
  const ins = db.prepare(`INSERT INTO observations
    (memory_session_id, project, type, title, narrative, text, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const now = Date.now();
  ins.run('s1', project, 'decision', 'Use UDS sockets', 'Decided to use UDS for the daemon transport.', null, new Date(now).toISOString(), now);
  ins.run('s1', project, 'feature', 'Memory-Bank Export', 'Cline-compatible markdown export of observations.', null, new Date(now).toISOString(), now-1);
  ins.run('s1', project, 'change', 'Updated PRAGMA stack', 'Added busy_timeout and mmap_size.', null, new Date(now).toISOString(), now-2);
  ins.run('s1', project, 'bugfix', 'Fixed FK constraint', 'Sentinel session_db_id=0 was breaking inserts.', null, new Date(now).toISOString(), now-3);
  ins.run('s1', project, 'discovery', 'Worker daemon exists', 'Found unused daemon on port 37777.', null, new Date(now).toISOString(), now-4);
  ins.run('s1', project, 'refactor', 'Extracted constants', 'Moved INTERESTING_TOOLS to lib/constants.', null, new Date(now).toISOString(), now-5);
  db.close();
}

test('exports 4 markdown files for a project', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cm-mb-'));
  const dbPath = join(tmp, 'claude-mem.db');
  const out = join(tmp, 'memory-bank');
  seedDb(dbPath, 'plugin-fix');
  const r = spawnSync('bun', [EXPORTER, '--project', 'plugin-fix', '--out', out, '--db', dbPath], { encoding: 'utf-8' });
  expect(r.status).toBe(0);
  for (const f of ['projectbrief.md', 'activeContext.md', 'systemPatterns.md', 'progress.md']) {
    expect(existsSync(join(out, f))).toBe(true);
  }
  const brief = readFileSync(join(out, 'projectbrief.md'), 'utf-8');
  expect(brief).toMatch(/Use UDS sockets/);
  expect(brief).toMatch(/Memory-Bank Export/);
  const patterns = readFileSync(join(out, 'systemPatterns.md'), 'utf-8');
  expect(patterns).toMatch(/Architectural decisions/);
  expect(patterns).toMatch(/Refactors/);
  const stats = JSON.parse(r.stdout);
  expect(stats.decisions).toBe(1);
  expect(stats.features).toBe(1);
  rmSync(tmp, { recursive: true, force: true });
});

test('fails cleanly when no project given', () => {
  const r = spawnSync('bun', [EXPORTER, '--out', '/tmp/x'], { encoding: 'utf-8' });
  expect(r.status).toBe(2);
});

test('fails cleanly when DB missing', () => {
  const r = spawnSync('bun', [EXPORTER, '--project', 'x', '--out', '/tmp/x', '--db', '/tmp/__nonexistent__.db'], { encoding: 'utf-8' });
  expect(r.status).toBe(2);
});
