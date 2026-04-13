import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';

describe('SessionSearch', () => {
  let tempDir: string;
  let dbPath: string;
  let store: SessionStore;
  let search: SessionSearch;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'claude-mem-session-search-'));
    dbPath = join(tempDir, 'claude-mem.db');
    store = new SessionStore(dbPath);
    search = new SessionSearch(dbPath);
  });

  afterEach(() => {
    search.close();
    store.close();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // bun:sqlite can hold Windows temp handles briefly after close; cleanup is best-effort here.
    }
  });

  function seedObservation(args: {
    contentSessionId: string;
    memorySessionId: string;
    project: string;
    title: string;
    narrative: string;
    type?: 'decision' | 'bugfix' | 'feature' | 'refactor' | 'discovery' | 'change';
    concepts?: string[];
    filesRead?: string[];
    filesModified?: string[];
    createdAtEpoch: number;
  }): number {
    const sdkId = store.createSDKSession(args.contentSessionId, args.project, 'seed prompt');
    store.updateMemorySessionId(sdkId, args.memorySessionId);

    return store.storeObservation(
      args.memorySessionId,
      args.project,
      {
        type: args.type ?? 'discovery',
        title: args.title,
        subtitle: null,
        facts: [],
        narrative: args.narrative,
        concepts: args.concepts ?? [],
        files_read: args.filesRead ?? [],
        files_modified: args.filesModified ?? [],
      },
      1,
      0,
      args.createdAtEpoch
    ).id;
  }

  it('filters and sorts observations for filter-only searches', () => {
    const now = Date.now();
    seedObservation({
      contentSessionId: 'content-1',
      memorySessionId: 'memory-1',
      project: 'proj-a',
      title: 'Older auth note',
      narrative: 'auth details',
      concepts: ['auth'],
      filesRead: ['src/auth.ts'],
      createdAtEpoch: now - 10_000,
    });
    seedObservation({
      contentSessionId: 'content-2',
      memorySessionId: 'memory-2',
      project: 'proj-a',
      title: 'Newest auth note',
      narrative: 'auth details',
      concepts: ['auth'],
      filesRead: ['src/auth.ts'],
      createdAtEpoch: now - 1_000,
    });
    seedObservation({
      contentSessionId: 'content-3',
      memorySessionId: 'memory-3',
      project: 'proj-b',
      title: 'Wrong project',
      narrative: 'auth details',
      concepts: ['auth'],
      filesRead: ['src/auth.ts'],
      createdAtEpoch: now - 500,
    });

    const results = search.searchObservations(undefined, {
      project: 'proj-a',
      concepts: 'auth',
      files: 'src/auth.ts',
      dateRange: { start: now - 20_000, end: now },
      orderBy: 'date_asc',
    });

    expect(results.map(result => result.title)).toEqual([
      'Older auth note',
      'Newest auth note',
    ]);
  });

  it('tracks access timestamps and counts on observations', () => {
    const observationId = seedObservation({
      contentSessionId: 'content-access',
      memorySessionId: 'memory-access',
      project: 'proj-a',
      title: 'Accessed note',
      narrative: 'useful detail',
      createdAtEpoch: Date.now() - 86_400_000,
    });

    search.updateAccessTracking([observationId]);
    search.updateAccessTracking([observationId]);

    const updated = store.getObservationById(observationId);
    expect(updated?.access_count).toBe(2);
    expect(updated?.last_accessed_at).toBeNumber();
    expect((updated?.last_accessed_at ?? 0)).toBeGreaterThan(1_000_000_000);
  });

  it('uses last_accessed_at when ranking temporal freshness', () => {
    const now = Date.now();
    const olderButAccessedId = seedObservation({
      contentSessionId: 'content-old',
      memorySessionId: 'memory-old',
      project: 'proj-a',
      title: 'Older but refreshed',
      narrative: 'alpha',
      createdAtEpoch: now - 120 * 86_400_000,
    });
    const newerId = seedObservation({
      contentSessionId: 'content-new',
      memorySessionId: 'memory-new',
      project: 'proj-a',
      title: 'Newer but untouched',
      narrative: 'alpha',
      createdAtEpoch: now - 7 * 86_400_000,
    });

    store.db.prepare('UPDATE observations SET last_accessed_at = ?, access_count = 5 WHERE id = ?')
      .run(now, olderButAccessedId);

    const ranked = search.rankByTemporalScore([
      store.getObservationById(newerId)!,
      store.getObservationById(olderButAccessedId)!,
    ]);

    expect(ranked[0]?.id).toBe(olderButAccessedId);
  });
});
