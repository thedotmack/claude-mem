import { expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { HistoryImport } from '../../../src/services/setup/history-import.js';

it('reports a real SQLite open failure without an unhandled background rejection', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cmem-import-open-'));
  try {
    // Like the worker route, the caller starts the background import without
    // awaiting finished(). An uncaught async open error would kill this worker.
    const child = Bun.spawnSync([process.execPath, '-e', `
      import { Database } from 'bun:sqlite';
      import { HistoryImport } from ${JSON.stringify(new URL('../../../src/services/setup/history-import.ts', import.meta.url).href)};
      const run = new HistoryImport({
        openDatabase: () => new Database(process.env.IMPORT_SOURCE!, { readonly: true, create: false }),
        origin: () => 'http://127.0.0.1:1', token: () => 'owned-import-fixture',
      });
      run.start();
      await new Promise(resolve => setTimeout(resolve, 0));
      console.log(JSON.stringify(run.state()));
    `], { env: { ...process.env, IMPORT_SOURCE: join(directory, 'missing.sqlite'), DO_NOT_TRACK: '1', CLAUDE_MEM_TELEMETRY: '0' } });
    if (child.exitCode !== 0) process.stderr.write(child.stderr);
    expect(child.exitCode).toBe(0);
    const state = JSON.parse(child.stdout.toString().trim().split('\n').at(-1)!);
    expect(state).toMatchObject({ state: 'failed', sent: 0, imported: 0, skipped: 0 });
    expect(state.error).toMatch(/open|unable|file/i);
    expect(state.finishedAt).toBeString();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it('allows Continue after the source database becomes available', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cmem-import-open-retry-'));
  const file = join(directory, 'source.sqlite');
  let requests = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    requests++;
    const body = await request.json() as { observations: unknown[] };
    return Response.json({ stats: { observationsImported: body.observations.length, observationsSkipped: 0 } });
  } });
  const run = new HistoryImport({ openDatabase: () => new Database(file, { readonly: true, create: false }),
    origin: () => `http://127.0.0.1:${server.port}`, token: () => 'owned-import-fixture' });
  let store: SessionStore | undefined;
  try {
    run.start();
    expect(await run.finished()).toMatchObject({ state: 'failed', sent: 0 });
    expect(requests).toBe(0);
    store = new SessionStore(file);
    const session = store.createSDKSession('source-open', 'source-open', 'Import my memory');
    store.updateMemorySessionId(session, 'source-open-memory');
    store.storeObservation('source-open-memory', 'source-open', { type: 'discovery', title: 'Retained source',
      subtitle: null, narrative: 'Available after the first attempt', facts: [], concepts: [], files_read: [], files_modified: [] });
    run.start();
    expect(await run.finished()).toMatchObject({ state: 'done', sent: 1, imported: 1, error: null });
    expect(requests).toBe(1);
  } finally { server.stop(true); store?.close(); rmSync(directory, { recursive: true, force: true }); }
});
