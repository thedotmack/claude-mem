import { expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { HISTORY_IMPORT_BATCH, HistoryImport } from '../../../src/services/setup/history-import.js';

it('finishes the selected history while live writes continue, then includes new rows in a later run', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cmem-import-live-'));
  const file = join(directory, 'source.sqlite');
  const store = new SessionStore(file);
  const session = store.createSDKSession('live-import-content', 'live-import', 'Bring existing memory');
  store.updateMemorySessionId(session, 'live-import-memory');
  const append = (title: string) => store.storeObservation('live-import-memory', 'live-import', {
    type: 'discovery', title, subtitle: null, narrative: title,
    facts: [], concepts: [], files_read: [], files_modified: [],
  }, 1, 0);
  const initial = HISTORY_IMPORT_BATCH + 1;
  for (let index = 0; index < initial; index++) append(`existing ${index}`);
  const remote = append('synced from another device');
  store.db.prepare('UPDATE observations SET origin_device_id = ? WHERE id = ?').run('other-device', remote.id);

  const retained = new Set<string>();
  const sizes: number[] = [];
  let wroteDuringImport = false;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json() as { observations: Array<{ title: string }> };
    sizes.push(body.observations.length);
    if (!wroteDuringImport) {
      wroteDuringImport = true;
      // A separate writable connection remains live while the import's read-only
      // connection waits for this network receipt.
      append('written during upload');
      append('also written during upload');
    }
    let imported = 0;
    for (const observation of body.observations) {
      if (!retained.has(observation.title)) imported++;
      retained.add(observation.title);
    }
    return Response.json({ stats: { observationsImported: imported, observationsSkipped: body.observations.length - imported } });
  } });
  const run = new HistoryImport({ openDatabase: () => new Database(file, { readonly: true, create: false }),
    origin: () => server.url.origin, token: () => 'live-import-fixture' });
  try {
    run.start();
    expect(await run.finished()).toMatchObject({ state: 'done', total: initial, sent: initial,
      imported: initial, skipped: 0, percent: 100 });
    expect(sizes).toEqual([HISTORY_IMPORT_BATCH, 1]);
    expect(retained.has('written during upload')).toBe(false);
    expect(retained.has('also written during upload')).toBe(false);
    expect(retained.has('synced from another device')).toBe(false);

    run.start();
    expect(await run.finished()).toMatchObject({ state: 'done', total: initial + 2, sent: initial + 2,
      imported: 2, skipped: initial, percent: 100 });
    expect(sizes).toEqual([HISTORY_IMPORT_BATCH, 1, HISTORY_IMPORT_BATCH, 3]);
    expect(retained.has('written during upload')).toBe(true);
    expect(retained.has('also written during upload')).toBe(true);
    expect(retained.has('synced from another device')).toBe(false);
  } finally { server.stop(true); store.close(); rmSync(directory, { recursive: true, force: true }); }
});
