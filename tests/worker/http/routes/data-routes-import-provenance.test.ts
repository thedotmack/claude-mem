import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { DataRoutes } from '../../../../src/services/worker/http/routes/DataRoutes.js';

const provenanceFields = ['metadata', 'generated_by_model', 'occurrence_count', 'reinforcement_dates', 'last_reinforced'] as const;
const metadata = { source: 'memory-file', sourceFingerprint: 'note-revision', nested: { labels: ['restore', 'context'] } };

function exportedMemory() {
  const source = new SessionStore(':memory:', { syncOpsEnabled: false });
  try {
    const sessionId = source.createSDKSession('import-provenance-host', 'app', 'prompt');
    source.ensureMemorySessionIdRegistered(sessionId, 'import-provenance-memory');
    const observationId = source.storeObservation('import-provenance-memory', 'app', {
      type: 'discovery', title: 'Restored decision', subtitle: null,
      narrative: 'Keep the recorded source and reinforcement history',
      facts: ['Preserve provenance'], concepts: ['how-it-works'],
      files_read: ['src/main.ts'], files_modified: [], metadata: JSON.stringify(metadata),
    }, 1, 0, 1_700_000_000_000).id;
    source.db.prepare(`UPDATE observations SET generated_by_model = ?, occurrence_count = ?,
      reinforcement_dates = ?, last_reinforced = ? WHERE id = ?`)
      .run('recorded-observer', 4, '["2023-11-14","2026-11-01"]', '2026-11-01', observationId);
    return {
      sessions: source.getSdkSessionsBySessionIds(['import-provenance-memory']),
      observations: source.getObservationsByIds([observationId]) as unknown as Record<string, unknown>[],
    };
  } finally { source.close(); }
}

// CloudSync's canonical observation body decodes JSON columns, encodes numeric
// counters as decimals, and omits the device-local reinforcement columns.
function cloudObservation(exported: Record<string, unknown>): Record<string, unknown> {
  const row = { ...exported };
  for (const field of ['facts', 'concepts', 'files_read', 'files_modified', 'metadata']) {
    row[field] = row[field] == null ? null : JSON.parse(row[field] as string);
  }
  for (const field of ['prompt_number', 'discovery_tokens', 'created_at_epoch']) {
    row[field] = row[field] == null ? null : String(row[field]);
  }
  for (const field of ['occurrence_count', 'reinforcement_dates', 'last_reinforced']) delete row[field];
  return row;
}

describe('HTTP import preserves observation provenance in supported export shapes', () => {
  let store: SessionStore;
  let server: Server;
  let url: string;

  beforeEach(async () => {
    store = new SessionStore(':memory:', { syncOpsEnabled: false });
    const app = express();
    app.use(express.json());
    new DataRoutes(
      {} as any, { getSessionStore: () => store, getChromaSync: () => null } as any,
      {} as any, {} as any, {} as any, Date.now(),
    ).setupRoutes(app);
    server = await new Promise<Server>(resolve => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No owned HTTP listener');
    url = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    store.close();
  });

  async function importMemory(payload: ReturnType<typeof exportedMemory>) {
    const response = await fetch(`${url}/api/import`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    expect(response.status).toBe(200);
    return await response.json() as {
      stats: { observationsImported: number; observationsSkipped: number; observationsRejected: number };
      rejected: { observations: Array<{ index: number; reason: string }> };
    };
  }

  for (const cloudMetadata of [metadata, {}]) {
    it(`imports cloud object metadata ${Object.keys(cloudMetadata).length ? 'with nested provenance' : 'when empty'}`, async () => {
      const payload = exportedMemory();
      payload.observations = [{ ...cloudObservation(payload.observations[0]), metadata: cloudMetadata }];
      const result = await importMemory(payload);
      expect(result.stats.observationsImported).toBe(1);
      expect(result.stats.observationsRejected).toBe(0);
      const restored = store.db.query(`SELECT metadata, generated_by_model, occurrence_count,
        reinforcement_dates, last_reinforced, facts, files_read FROM observations`).get() as Record<string, unknown>;
      expect(JSON.parse(restored.metadata as string)).toEqual(cloudMetadata);
      expect(restored.generated_by_model).toBe('recorded-observer');
      expect(restored.occurrence_count).toBe(1);
      expect(restored.reinforcement_dates).toBeNull();
      expect(restored.last_reinforced).toBeNull();
      expect(JSON.parse(restored.facts as string)).toEqual(['Preserve provenance']);
      expect(JSON.parse(restored.files_read as string)).toEqual(['src/main.ts']);
    });
  }

  it('keeps native JSON text and all reinforcement fields unchanged through HTTP import and replay', async () => {
    const payload = exportedMemory();
    const result = await importMemory(payload);
    expect(result.stats.observationsImported).toBe(1);
    expect(result.stats.observationsRejected).toBe(0);
    const restored = store.db.query('SELECT * FROM observations').get() as Record<string, unknown>;
    for (const field of provenanceFields) expect(restored[field]).toEqual(payload.observations[0][field]);
    store.db.run('UPDATE observations SET occurrence_count = 9');
    const replayed = await importMemory(payload);
    expect(replayed.stats.observationsImported).toBe(0);
    expect(replayed.stats.observationsSkipped).toBe(1);
    expect(store.db.query('SELECT COUNT(*) AS n, occurrence_count FROM observations').get())
      .toEqual({ n: 1, occurrence_count: 9 });
  });

  it('retains legacy absent and explicit null metadata', async () => {
    const payload = exportedMemory();
    const legacy = { ...payload.observations[0] };
    for (const field of provenanceFields) delete legacy[field];
    payload.observations = [legacy, { ...legacy, title: 'Null metadata export', metadata: null }];
    const result = await importMemory(payload);
    expect(result.stats.observationsImported).toBe(2);
    expect(result.stats.observationsRejected).toBe(0);
    expect(store.db.query('SELECT metadata, generated_by_model, occurrence_count, reinforcement_dates, last_reinforced FROM observations').all())
      .toEqual(Array.from({ length: 2 }, () => ({ metadata: null, generated_by_model: null, occurrence_count: 1, reinforcement_dates: null, last_reinforced: null })));
  });

  it('reports invalid optional fields per row without dropping a valid cloud observation in the same batch', async () => {
    const payload = exportedMemory();
    const invalid: Record<string, unknown>[] = [
      { metadata: false }, { metadata: 123 }, { generated_by_model: {} },
      { occurrence_count: '4' }, { reinforcement_dates: {} }, { last_reinforced: false },
    ];
    payload.observations = [
      ...invalid.map((fields, index) => ({ ...payload.observations[0], title: `Invalid row ${index}`, ...fields })),
      cloudObservation(payload.observations[0]),
    ];
    const result = await importMemory(payload);
    expect(result.stats.observationsImported).toBe(1);
    expect(result.stats.observationsRejected).toBe(invalid.length);
    for (const [index, fields] of invalid.entries()) {
      expect(result.rejected.observations[index].index).toBe(index);
      expect(result.rejected.observations[index].reason).toContain(Object.keys(fields)[0]);
    }
    expect(store.db.query('SELECT title, metadata FROM observations').all())
      .toEqual([{ title: 'Restored decision', metadata: JSON.stringify(metadata) }]);
  });
});
