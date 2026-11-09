import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { configureToolUseIndex } from '../../src/services/sqlite/tool-use-search.js';
import { DeepSearchClient } from '../../src/services/deep-search/DeepSearchClient.js';
import { getDeepSearchProgram } from '../../src/services/deep-search/child-program.js';
import { readSnapshotProbe, waitForReadSnapshot } from '../helpers/deep-search-snapshot.js';

const clients: DeepSearchClient[] = [];
const stores: SessionStore[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map(c => c.close()));
  stores.splice(0).forEach(s => s.close());
  Bun.gc(true); // Finalize fixture statements before unlinking SQLite files on Windows.
  dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true }));
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'cm-deep-process-')); dirs.push(dir);
  const dbPath = join(dir, 'memory.db');
  const store = new SessionStore(dbPath); stores.push(store);
  const write = (id: string, project = 'one', response = 'unique_marker 中文🧪', source = 'claude-code') => store.upsertToolUse({
    toolUseId: id, contentSessionId: 'session', project, toolName: 'Read', toolInput: '{}', toolResponse: response,
    createdAtEpoch: 1000, platformSource: source as any });
  const client = (deadlineMs = 1000, program?: () => Promise<string>, spawnFn?: typeof spawn) => {
    const c = new DeepSearchClient(dbPath, { deadlineMs, program, spawn: spawnFn }); clients.push(c); return c;
  };
  return { store, write, client, dbPath };
}

describe('real deep search process', () => {
  it('cleans up the production child after host death during an observed raw SQL read', async () => {
    const f = fixture(); f.write('a');
    const body = '一 ' + Array.from({ length: 400 }, (_, i) => `x${i}`).join(' ');
    f.store.db.transaction(() => { for (let i = 0; i < 32000; i++) f.write(`slow-${i}`, 'slow', body); })();
    configureToolUseIndex(f.store.db, true);
    const pinned = readSnapshotProbe(f.store.db);
    const host = spawn(process.execPath, ['-e', `
      import {DeepSearchClient} from './src/services/deep-search/DeepSearchClient.ts';
      import {spawn} from 'node:child_process';
      const client = new DeepSearchClient(${JSON.stringify(f.dbPath)}, {deadlineMs:10000, spawn: (...args) => {
        const child=spawn(...args); console.log(JSON.stringify({pid:child.pid})); return child;
      }});
      try { await client.search(${JSON.stringify(body + ' absent')}, {project:'slow'}); }
      finally { await client.close(); }
    `], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, BUN_BE_BUN: '1' } });
    const hostExited = new Promise<void>(resolveExit => host.once('close', () => resolveExit()));
    let childPid: number | undefined;
    host.stderr.resume();
    try {
      childPid = await new Promise<number>((resolvePid, reject) => {
        let output = '';
        const timer = setTimeout(() => reject(new Error('Production child not spawned')), 3000);
        host.stdout.on('data', chunk => {
          output += chunk.toString();
          if (output.includes('\n')) { clearTimeout(timer); resolvePid(JSON.parse(output.split('\n')[0]).pid); }
        });
        host.once('error', error => { clearTimeout(timer); reject(error); });
        host.once('close', () => { clearTimeout(timer); reject(new Error('Host exited before spawning')); });
      });
      await waitForReadSnapshot(pinned, () => host.exitCode !== null || host.signalCode !== null, 3000);
      host.kill('SIGKILL'); await hostExited;
      const deadline = performance.now() + 2000; // well before the child's 10 s deadline
      while (true) {
        try { process.kill(childPid!, 0); } catch { break; }
        if (performance.now() >= deadline) throw new Error('Production child survived its parent');
        await Bun.sleep(10);
      }
      expect((f.store.db.query('PRAGMA wal_checkpoint(TRUNCATE)').get() as any).busy).toBe(0);
      expect((await f.client().search('unique_marker', { project: 'one' })).deep.status).toBe('ok');
    } finally {
      host.kill('SIGKILL'); await hostExited;
      if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch {} }
    }
  }, 60_000);

  it('queries stored data with project/platform/date scope and closes its read-only DB', async () => {
    const f = fixture(); const id = f.write('a'); f.write('b', 'other'); f.write('c', 'one', 'unique_marker', 'codex');
    configureToolUseIndex(f.store.db, true);
    const before = f.store.db.query('SELECT total_changes() AS n').get();
    const c = f.client();
    const result = await c.search('unique_marker', { projects: ['one'], platformSource: 'claude-code', dateRange: { start: 0, end: 2000 } });
    expect(result.deep).toEqual({ status: 'ok', complete: true, count: 1, hasMore: false });
    expect(result.toolUses[0].id).toBe(id!);
    expect((await c.search('中文', { projects: ['one'] })).toolUses[0].snippet).toContain('中文');
    expect(f.store.db.query('SELECT total_changes() AS n').get()).toEqual(before);
    expect((f.store.db.query('PRAGMA wal_checkpoint(TRUNCATE)').get() as any).busy).toBe(0);
  });

  it('flushes large UTF-8 replies before exit and reads committed data while a WAL writer is active', async () => {
    const f = fixture(); const id = f.write('large'); configureToolUseIndex(f.store.db, true);
    // Metadata is intentionally near the transport bound; snippets alone are
    // too small to exercise a pipe write spanning multiple buffers.
    const toolName = '测'.repeat(40_000);
    f.store.db.run('UPDATE tool_uses SET tool_name = ? WHERE id = ?', [toolName, id!]);
    const c = f.client();
    f.store.db.run('BEGIN IMMEDIATE');
    try {
      f.store.db.run('UPDATE tool_uses SET tool_name = ? WHERE id = ?', ['uncommitted', id!]);
      for (let i = 0; i < 3; i++) {
        const result = await c.search('unique_marker', { project: 'one' });
        expect(result.deep.status).toBe('ok');
        expect(result.toolUses[0].tool_name).toBe(toolName);
        expect(Buffer.byteLength(JSON.stringify(result))).toBeGreaterThan(120_000);
      }
    } finally { f.store.db.run('ROLLBACK'); }
    expect((f.store.db.query('PRAGMA wal_checkpoint(TRUNCATE)').get() as any).busy).toBe(0);
  });

  it('terminates actual native SQL, frees the WAL snapshot, and recovers', async () => {
    const f = fixture(); f.write('a'); configureToolUseIndex(f.store.db, true);
    // The production process/guard runs a real intentionally expensive substring
    // query. All terms but the last match, forcing a scan rather than LIMIT work.
    const terms = Array.from({ length: 400 }, (_, i) => `x${i}`);
    const body = '一 ' + terms.join(' ');
    f.store.db.transaction(() => { for (let i = 0; i < 32000; i++) f.write(`slow-${i}`, 'slow', body); })();
    const program = await getDeepSearchProgram(); // startup is tested separately
    const children: ReturnType<typeof spawn>[] = [];
    const launch = ((...args: Parameters<typeof spawn>) => { const p = spawn(...args); children.push(p); return p; }) as typeof spawn;
    const c = f.client(3000, async () => program, launch);
    const pinned = readSnapshotProbe(f.store.db);
    const started = performance.now();
    const pending = c.search(body + ' missing', { project: 'slow' });
    expect((await c.search('unique_marker')).deep.status).toBe('busy');
    await waitForReadSnapshot(pinned, () => !!children[0]?.signalCode, 2500);
    const result = await pending;
    expect(result.deep.status).toBe('timeout');
    expect(performance.now() - started).toBeLessThan(6000);
    await new Promise<void>(resolve => children[0].exitCode !== null || children[0].signalCode !== null ? resolve() : children[0].once('close', () => resolve()));
    expect(children[0].signalCode).toBe('SIGKILL');
    const recovered = await c.search('unique_marker', { project: 'one' });
    expect(recovered.deep.status).toBe('ok');
    expect(recovered.toolUses).toHaveLength(1);
    expect((f.store.db.query('PRAGMA wal_checkpoint(TRUNCATE)').get() as any).busy).toBe(0);

    // A failed parent kill must keep the slot occupied. The independent guard
    // is exercised here, not replaced by a fake exit notification.
    for (const failure of ['return-false', 'throw']) {
      let processChild: ReturnType<typeof spawn> | undefined;
      const failingKill = ((...args: Parameters<typeof spawn>) => {
        const p = spawn(...args); processChild = p;
        p.kill = (() => { if (failure === 'throw') throw new Error('fixture kill failure'); return false; }) as any;
        return p;
      }) as typeof spawn;
      const guarded = f.client(3000, async () => program, failingKill);
      const query = guarded.search(body + ' missing', { project: 'slow' });
      await waitForReadSnapshot(pinned, () => false, 2500);
      expect((await query).deep.status).toBe('timeout');
      // The unit test pins the busy-before-close boundary deterministically.
      // Here the independent guard may already have exited on a slow runner.
      await guarded.close(); // resolves only when the child-side guard really exits
      expect(processChild!.exitCode !== null || processChild!.signalCode !== null).toBe(true);
      expect((f.store.db.query('PRAGMA wal_checkpoint(TRUNCATE)').get() as any).busy).toBe(0);
    }
  }, 60_000);

  it('does not create a missing database or silently fall back to inline reads', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-deep-missing-')); dirs.push(dir);
    const c = new DeepSearchClient(join(dir, 'missing.db')); clients.push(c);
    expect((await c.search('needle')).deep.status).toBe('error');
  });
});
