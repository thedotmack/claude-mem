import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { getObservationsByFilePath } from '../../../src/services/sqlite/observations/get.js';

describe('file context recency when timestamps tie', () => {
  let store: SessionStore;
  let serial = 0;
  const epoch = 1_700_000_000_000;

  beforeEach(() => { store = new SessionStore(':memory:'); serial = 0; });
  afterEach(() => store.close());

  function seed(options: { at?: number; paths?: string[]; project?: string; platform?: string } = {}): number {
    const identity = `file-recency-${++serial}`;
    const project = options.project ?? 'repo';
    const session = store.createSDKSession(identity, project, 'prompt', undefined, options.platform ?? 'claude');
    store.ensureMemorySessionIdRegistered(session, identity);
    return store.storeObservations(identity, project, [{
      type: 'discovery', title: identity, subtitle: null, narrative: identity, facts: [], concepts: [],
      files_read: options.paths ?? ['src/main.ts'], files_modified: [],
    }], null, 0, 0, options.at ?? epoch).observationIds[0];
  }

  it('keeps the newest observations from a same-millisecond batch before applying the limit', () => {
    const ids = Array.from({ length: 6 }, () => seed());
    expect(getObservationsByFilePath(store.db, 'src/main.ts', { limit: 2 }).map(row => row.id))
      .toEqual(ids.slice(-2).reverse());
  });

  it('orders equal timestamps globally across path aliases without duplicating a row', () => {
    const first = seed({ paths: ['src/main.ts'] });
    const second = seed({ paths: ['/checkout/src/main.ts'] });
    const latest = seed({ paths: ['src/main.ts', '/checkout/src/main.ts'] });
    for (const paths of [['src/main.ts', '/checkout/src/main.ts'], ['/checkout/src/main.ts', 'src/main.ts']]) {
      expect(getObservationsByFilePath(store.db, paths).map(row => row.id)).toEqual([latest, second, first]);
      expect(getObservationsByFilePath(store.db, paths, { limit: 2 }).map(row => row.id)).toEqual([latest, second]);
    }
  });

  it('applies project and platform scope before selecting tied rows', () => {
    seed();
    const latest = seed();
    seed({ project: 'other' });
    seed({ platform: 'codex' });
    expect(getObservationsByFilePath(store.db, 'src/main.ts', {
      projects: ['repo'], platformSource: 'claude', limit: 1,
    }).map(row => row.id)).toEqual([latest]);
  });

  it('keeps the timestamp as the primary ordering key', () => {
    const newer = seed({ at: epoch + 1 });
    seed({ at: epoch - 1 });
    expect(getObservationsByFilePath(store.db, 'src/main.ts', { limit: 1 }).map(row => row.id)).toEqual([newer]);
  });
});
