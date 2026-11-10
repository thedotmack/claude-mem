import { expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { HISTORY_IMPORT_BATCH, HistoryImport } from '../../../src/services/setup/history-import.js';

async function withImport(count: number, respond: (request: Request) => Promise<Response>, check: (run: HistoryImport) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'cmem-import-ack-'));
  const file = join(directory, 'source.sqlite');
  const store = new SessionStore(file);
  const session = store.createSDKSession('import-ack-content', 'import-ack', 'Restore these observations');
  store.updateMemorySessionId(session, 'import-ack-memory');
  for (let index = 0; index < count; index++) {
    store.storeObservation('import-ack-memory', 'import-ack', {
      type: 'discovery', title: `Receipt evidence ${index}`, subtitle: null, narrative: `Evidence ${index}`,
      facts: [], concepts: [], files_read: [], files_modified: [],
    }, 1, 0, 1700000000000 + index);
  }
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: respond });
  const run = new HistoryImport({ openDatabase: () => new Database(file, { readonly: true, create: false }),
    origin: () => `http://127.0.0.1:${server.port}`, token: () => 'owned-import-fixture' });
  try { await check(run); }
  finally { server.stop(true); store.close(); rmSync(directory, { recursive: true, force: true }); }
}

it('keeps an unacknowledged final batch out of success and safely resends it on Continue', async () => {
  let validReceipt = false;
  const retained = new Set<string>();
  const sizes: number[] = [];
  await withImport(HISTORY_IMPORT_BATCH + 1, async request => {
    const body = await request.json() as { observations: Array<{ title: string }> };
    sizes.push(body.observations.length);
    let imported = 0;
    for (const observation of body.observations) {
      if (!retained.has(observation.title)) imported++;
      retained.add(observation.title);
    }
    if (!validReceipt && sizes.length === 2) return new Response('<html>upstream response interrupted</html>');
    return Response.json({ stats: { observationsImported: imported, observationsSkipped: body.observations.length - imported } });
  }, async run => {
    run.start();
    expect(await run.finished()).toMatchObject({ state: 'failed', sent: HISTORY_IMPORT_BATCH,
      imported: HISTORY_IMPORT_BATCH, skipped: 0, percent: 99 });
    expect(run.state().error).toContain('acknowledge');
    validReceipt = true;
    run.start();
    expect(await run.finished()).toMatchObject({ state: 'done', sent: HISTORY_IMPORT_BATCH + 1,
      imported: 0, skipped: HISTORY_IMPORT_BATCH + 1, percent: 100, error: null });
    expect(sizes).toEqual([HISTORY_IMPORT_BATCH, 1, HISTORY_IMPORT_BATCH, 1]);
    expect(retained.size).toBe(HISTORY_IMPORT_BATCH + 1);
  });
});

for (const stats of [undefined, { observationsImported: 1 },
  { observationsImported: '1', observationsSkipped: 0 },
  { observationsImported: -1, observationsSkipped: 2 },
  { observationsImported: 0.5, observationsSkipped: 0.5 },
  { observationsImported: 0, observationsSkipped: 0 },
  { observationsImported: 1, observationsSkipped: 1 }]) {
  it(`refuses an incomplete or invalid batch receipt: ${JSON.stringify(stats)}`, async () => {
    await withImport(1, async () => Response.json({ stats }), async run => {
      run.start();
      expect(await run.finished()).toMatchObject({ state: 'failed', sent: 0, imported: 0, skipped: 0 });
      expect(run.state().error).toContain('acknowledge');
    });
  });
}
