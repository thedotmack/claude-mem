import { describe, expect, it } from 'bun:test';
import { observationSyncBodyBound, planImport, type ImportNote, type ImportOptions } from '../../../src/npx-cli/commands/import-memory.js';
import { saveMemory } from '../../../src/services/memory/save-memory.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { getNativeContentOperation } from '../../../src/services/sync/CloudSync.js';
import { CONTENT_BODY_MAX_BYTES, ORIGIN_DEVICE_ID_MAX_BYTES } from '../../../src/shared/cloud-sync-limits.js';

/**
 * `claude-mem import` refuses a record before any write when cloud sync would refuse the
 * observation it becomes. It cannot load the sync code, so it bounds the body itself
 * (observationSyncBodyBound). These tests save imported notes through the real save path
 * and build their real sync bodies with the real CloudSync code, so a change on either side
 * that the bound no longer covers fails here.
 */
const mem0: ImportOptions = { provider: 'mem0', account: 'fixture-account', scope: 'fixture-user', project: 'imported "project" é' };
const supermemory: ImportOptions = { ...mem0, provider: 'supermemory', scope: 'fixture_namespace' };
const memoryRow = (memory: string) => ({ id: 'm1', memory, user_id: mem0.scope, created_at: '2026-11-01T00:00:00Z', metadata: { team: 'fixture', nested: { list: [1, 'two', null] } } });
const documentRow = { id: 'd1', title: 'Fixture document', type: 'text', content: 'Document text with a tab\tand a quote ".', summary: null, metadata: {}, url: null,
  system: { status: 'done', dreamingStatus: 'dreaming', memoryCount: 2, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' } };
const DEVICE_IDS = ['short-device', '\u0000'.repeat(ORIGIN_DEVICE_ID_MAX_BYTES), 'é'.repeat(ORIGIN_DEVICE_ID_MAX_BYTES / 2)];
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

function openStore() {
  const store = new SessionStore(':memory:');
  const manager = { getConnection: () => store.db, getSessionStore: () => store, getCloudSync: () => null, getChromaSync: () => null };
  return { store, save: (note: Pick<ImportNote, 'text' | 'title' | 'project' | 'metadata'>) => saveMemory(manager as any, 'default-project', note) };
}

function expectBoundCoversRealBody(note: ImportNote, store: SessionStore, id: number) {
  const bound = observationSyncBodyBound(note) as Record<string, unknown> & { payload: Record<string, unknown> };
  for (const deviceId of DEVICE_IDS) {
    const body = getNativeContentOperation(store.db, 'observation', String(id), deviceId)!.operation.body;
    const real = JSON.parse(body) as Record<string, unknown> & { payload: Record<string, unknown> };
    // The same fields: a field the sync adds or drops fails here until the bound has it too.
    expect(Object.keys(bound).sort()).toEqual(Object.keys(real).sort());
    expect(Object.keys(bound.payload).sort()).toEqual(Object.keys(real.payload).sort());
    // Each field of the real body is at most as long as the bound's.
    for (const key of Object.keys(real)) if (key !== 'payload') expect([key, bytes(real[key])]).toEqual([key, Math.min(bytes(real[key]), bytes(bound[key]))]);
    for (const key of Object.keys(real.payload)) expect([key, bytes(real.payload[key])]).toEqual([key, Math.min(bytes(real.payload[key]), bytes(bound.payload[key]))]);
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(bytes(bound));
  }
}

describe('the import size check bounds the body cloud sync builds for an imported note', () => {
  it('covers every field of the real body of Mem0 memories, Supermemory memories and documents', () => {
    const notes = [
      planImport([memoryRow('Use UTC for scheduled jobs.')], mem0).notes[0],
      planImport([memoryRow('  Trimmed by the worker; 日本 and 😀 and a lone \ud800 surrogate.\n')], mem0).notes[0],
      planImport([{ ...memoryRow('Filed for another host.'), id: 's1', isLatest: true, isForgotten: false }], { ...supermemory, platformSource: 'codex' }).notes[0],
      planImport([documentRow], { ...supermemory, documents: true }).notes[0],
    ];
    for (const note of notes) {
      const { store, save } = openStore();
      try {
        const saved = save(note);
        expect(saved.duplicate).toBeUndefined();
        expectBoundCoversRealBody(note, store, saved.id);
      } finally { store.close(); }
    }
  });

  it('covers a manual session id that needed its UUID suffix', () => {
    const note = planImport([memoryRow('A note whose session id collides.')], { ...mem0, project: 'imported-notes', platformSource: 'zed' }).notes[0];
    const { store, save } = openStore();
    try {
      // Another project and host whose base session id is the same string, manual-imported-notes-zed.
      save({ text: 'Earlier note.', title: 'Earlier note', project: 'imported', metadata: { platformSource: 'notes-zed' } });
      const saved = save(note);
      const sessionId = (store.db.query('SELECT memory_session_id FROM observations WHERE id = ?').get(saved.id) as { memory_session_id: string }).memory_session_id;
      expect(sessionId).toMatch(/^manual-imported-notes-zed-[0-9a-f-]{36}$/);
      expectBoundCoversRealBody(note, store, saved.id);
    } finally { store.close(); }
  });

  it('a note at the import limit still syncs, with the longest device id', () => {
    const padded = (length: number) => planImport([{ ...memoryRow('At the limit.'), pad: 'x'.repeat(length) }], mem0).notes[0];
    const note = padded(CONTENT_BODY_MAX_BYTES - bytes(observationSyncBodyBound(padded(0))));
    expect(bytes(observationSyncBodyBound(note))).toBe(CONTENT_BODY_MAX_BYTES);
    const { store, save } = openStore();
    try {
      const saved = save(note);
      const body = getNativeContentOperation(store.db, 'observation', String(saved.id), DEVICE_IDS[1])!.operation.body;
      expect(Buffer.byteLength(body)).toBeLessThanOrEqual(CONTENT_BODY_MAX_BYTES);
    } finally { store.close(); }
  });
});
