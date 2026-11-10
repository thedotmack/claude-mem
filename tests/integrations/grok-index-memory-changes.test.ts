import { beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A separate process keeps route-suite mocks and frozen path constants out of
// the real worker -> SQLite -> on-disk Grok INDEX path.
const fixture = String.raw`
  import express from 'express';
  import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
  import { join } from 'node:path';
  import { SessionStore } from './src/services/sqlite/SessionStore.ts';
  import { SyncApply } from './src/services/sync/SyncApply.ts';
  import { DataRoutes } from './src/services/worker/http/routes/DataRoutes.ts';
  import { ModeManager } from './src/services/domain/ModeManager.ts';
  import { DB_PATH, USER_SETTINGS_PATH } from './src/shared/paths.ts';
  import {
    refreshGrokBotIndexes, watchGrokBotIndexChanges, stopGrokBotIndexChanges, resetGrokBotIndexWriterForTests,
  } from './src/services/integrations/GrokBotIndexWriter.ts';
  const id = '11111111-2222-4333-8444-555555555555';
  const seatDir = join(process.env.GROK_BOT_AGENT_DATA, 'agents', id);
  mkdirSync(join(seatDir, 'memory', 'log'), { recursive: true });
  writeFileSync(join(seatDir, 'profile.json'), JSON.stringify({ name: 'Fixture' }));
  mkdirSync(process.env.CLAUDE_MEM_DATA_DIR, { recursive: true });
  writeFileSync(USER_SETTINGS_PATH, JSON.stringify({
    CLAUDE_MEM_GROK_BOT_INJECT_PROJECTS_BY_AGENT: id + '=seat',
    CLAUDE_MEM_GROK_BOT_INJECT_FALLBACK: 'off',
    CLAUDE_MEM_GROK_BOT_INJECT_DEBOUNCE_MS: '0',
  }));
  ModeManager.getInstance().loadMode('code');
  const store = new SessionStore(DB_PATH);
  const memory = store.getOrCreateManualSession('seat');
  const initial = store.storeObservation(memory, 'seat', {
    type: 'discovery', title: 'DELETE THIS SAVED MEMORY', subtitle: null,
    facts: [], narrative: 'Initial memory', concepts: ['how-it-works'],
    files_read: [], files_modified: [],
  });
  const indexPath = join(seatDir, 'memory', 'log', 'zz-claude-mem-inject.md');
  const read = () => readFileSync(indexPath, 'utf8');
  const waitFor = async predicate => {
    const deadline = Date.now() + 800;
    do {
      if (predicate(read())) return read();
      await Bun.sleep(5);
    } while (Date.now() < deadline);
    return read();
  };
  await refreshGrokBotIndexes();
  const initialIndex = read();
  watchGrokBotIndexChanges();

  const facade = { getSessionStore: () => store, getCloudSync: () => null, getChromaSync: () => null };
  const app = express();
  new DataRoutes({}, facade, {}, { broadcast() {} }, {}, Date.now()).setupRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const body = {
      memory_session_id: memory, project: 'seat', text: null, type: 'discovery',
      title: 'IMPORTED MEMORY IS VISIBLE', subtitle: null, facts: '[]', narrative: 'Imported',
      concepts: '["how-it-works"]', files_read: '[]', files_modified: '[]', prompt_number: 1,
      discovery_tokens: 0, created_at: new Date().toISOString(), created_at_epoch: Date.now(),
    };
    const imported = store.importObservation(body);
    const afterImport = await waitFor(text => text.includes(body.title));
    // Re-seed each case independently so one stale refresh cannot mask the next.
    await refreshGrokBotIndexes();
    const apply = new SyncApply(store.db, { deviceId: 'this-device' });
    const remoteBody = { ...body, memory_session_id: 'remote-memory', title: 'SYNCED MEMORY IS VISIBLE' };
    const applied = apply.applyOps([{
      seq: '1', kind: 'observation', origin_device: 'peer-device', origin_id: '7', rev: '1',
      body: JSON.stringify(remoteBody), server_ts: Date.now(),
    }]);
    const afterSync = await waitFor(text => text.includes(remoteBody.title));
    await refreshGrokBotIndexes();
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/observation/' + initial.id,
      { method: 'DELETE' });
    const deleted = await response.json();
    const afterDelete = await waitFor(text => !text.includes('DELETE THIS SAVED MEMORY'));
    stopGrokBotIndexChanges();
    store.importObservation({ ...body, title: 'AFTER WRITER STOP', created_at_epoch: Date.now() + 1 });
    await Bun.sleep(30);
    console.log(JSON.stringify({ initialIndex, imported, applied, afterImport, afterSync,
      deleted, deleteStatus: response.status, afterDelete,
      afterStop: read(),
      deletedRow: store.db.query('SELECT id FROM observations WHERE id = ?').get(initial.id) }));
  } finally {
    resetGrokBotIndexWriterForTests();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  }
`;

let output: any;
beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'grok-index-memory-'));
  try {
    const run = Bun.spawnSync([process.execPath, '-e', fixture], {
      cwd: join(import.meta.dir, '../..'),
      env: { ...process.env, CLAUDE_MEM_DATA_DIR: join(dir, 'data'), CLAUDE_CONFIG_DIR: join(dir, 'config'),
        GROK_BOT_AGENT_DATA: join(dir, 'grok'), CLAUDE_MEM_GROK_BOT_INJECT_ENABLED: 'true' },
      stdout: 'pipe', stderr: 'pipe',
    });
    if (run.exitCode !== 0) throw new Error(new TextDecoder().decode(run.stderr));
    output = JSON.parse(new TextDecoder().decode(run.stdout).trim().split('\n').at(-1)!);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 15_000);

test('an imported observation reaches an idle seat INDEX', () => {
  expect(output.imported.imported).toBe(true);
  expect(output.afterImport).toContain('IMPORTED MEMORY IS VISIBLE');
});

test('a committed sync observation reaches an idle seat INDEX', () => {
  expect(output.applied.applied).toBe(1);
  expect(output.afterSync).toContain('SYNCED MEMORY IS VISIBLE');
});

test('deleting saved memory removes its stale INDEX fact', () => {
  expect(output.initialIndex).toContain('DELETE THIS SAVED MEMORY');
  expect(output.deleteStatus).toBe(200);
  expect(output.deleted.success).toBe(true);
  expect(output.deletedRow).toBeNull();
  expect(output.afterDelete).not.toContain('DELETE THIS SAVED MEMORY');
  expect(output.afterDelete).toContain('IMPORTED MEMORY IS VISIBLE');
  expect(output.afterDelete).toContain('SYNCED MEMORY IS VISIBLE');
});

test('stopping the worker INDEX watcher releases its memory subscription', () => {
  expect(output.afterStop).not.toContain('AFTER WRITER STOP');
  expect(output.afterStop).toBe(output.afterDelete);
});
