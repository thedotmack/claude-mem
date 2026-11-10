import { expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readSnapshotProbe, waitForReadSnapshot } from '../helpers/deep-search-snapshot.js';

it('retries a locked snapshot probe without claiming a reader or blocking the event loop', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-snapshot-'));
  const file = join(dir, 'probe.db');
  const db = new Database(file); db.run('PRAGMA journal_mode=WAL');
  const pinned = readSnapshotProbe(db);
  const reader = new Database(file); const writer = new Database(file);
  try {
    expect(pinned()).toBe(false);
    reader.run('BEGIN'); reader.query('SELECT * FROM deep_test_probe').all();
    writer.run('BEGIN IMMEDIATE'); writer.run('UPDATE deep_test_probe SET n=n+1');
    expect(pinned()).toBe(false); // busy is inconclusive, never a positive
    let released = false;
    const timer = setTimeout(() => { writer.run('COMMIT'); released = true; }, 20);
    try { await waitForReadSnapshot(pinned, () => false, 1000); }
    finally { clearTimeout(timer); }
    expect(released).toBe(true);
    reader.run('COMMIT'); expect(pinned()).toBe(false);
  } finally { reader.close(); writer.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});
