import { afterAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as realChromaMcpManager from '../../../src/services/sync/ChromaMcpManager.js';

const realChromaMcpManagerSnapshot = { ...realChromaMcpManager };

let existingObservationIds = new Set<number>();
let acceptingMutations = true;
let createCollectionCalls = 0;
// Runs inside chroma_create_collection, so a test can make the call fail in flight.
let onCreateCollection: (() => void) | null = null;
const addDocumentCalls: string[][] = [];
const addDocumentPayloads: Array<{ ids: string[]; documents: string[]; metadatas: Array<Record<string, unknown>> }> = [];

mock.module('../../../src/services/sync/ChromaMcpManager.js', () => ({
  ChromaMcpManager: {
    getInstance: () => ({
      acceptsMutations: () => acceptingMutations,
      callTool: async (toolName: string, args: Record<string, unknown>) => {
        if (toolName === 'chroma_create_collection') {
          createCollectionCalls += 1;
          onCreateCollection?.();
          return {};
        }

        if (toolName === 'chroma_get_documents') {
          const offset = Number(args.offset ?? 0);
          if (offset > 0) {
            return { metadatas: [] };
          }

          return {
            metadatas: [...existingObservationIds].sort((a, b) => a - b).map(sqliteId => ({
              sqlite_id: sqliteId,
              doc_type: 'observation',
            })),
          };
        }

        if (toolName === 'chroma_add_documents') {
          addDocumentCalls.push((args.ids as string[]) ?? []);
          addDocumentPayloads.push({
            ids: (args.ids as string[]) ?? [],
            documents: (args.documents as string[]) ?? [],
            metadatas: (args.metadatas as Array<Record<string, unknown>>) ?? [],
          });
          return {};
        }

        return {};
      },
    }),
  },
}));

import { ChromaSync } from '../../../src/services/sync/ChromaSync.js';
import { ChromaSyncState } from '../../../src/services/sync/ChromaSyncState.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { logger } from '../../../src/utils/logger.js';

afterAll(() => {
  mock.module('../../../src/services/sync/ChromaMcpManager.js', () => realChromaMcpManagerSnapshot);
});

function makeObservationRow(id: number, project: string, factCount = 0) {
  return {
    id,
    memory_session_id: `mem-${id}`,
    project,
    merged_into_project: null,
    platform_source: 'claude',
    text: null,
    type: 'discovery',
    title: `Observation ${id}`,
    subtitle: null,
    facts: JSON.stringify(Array.from({ length: factCount }, (_, index) => `Fact ${id}-${index + 1}`)),
    narrative: `Narrative ${id}`,
    concepts: '[]',
    files_read: '[]',
    files_modified: '[]',
    prompt_number: id,
    created_at_epoch: 1_700_000_000_000 + id,
  };
}

function makeStore(project: string, observationIds: number[]) {
  const observationRows = observationIds.map(id => makeObservationRow(id, project));
  return makeStoreFromRows(project, observationRows);
}

function makeStoreFromRows(project: string, observationRows: ReturnType<typeof makeObservationRow>[]) {

  return {
    db: {
      prepare(query: string) {
        return {
          all: (...params: Array<string | number>) => {
            // The one-time title-only requeue: bodiless rows at or below the watermark.
            if (query.includes("COALESCE(narrative, '') = ''")) {
              const watermark = Number(params[1] ?? 0);
              return observationRows.filter(row => row.id <= watermark && !row.narrative && !row.text);
            }

            if (query.includes('SELECT id') && query.includes('FROM observations') && !query.includes('LEFT JOIN')) {
              return observationRows.map(row => ({ id: row.id }));
            }

            if (query.includes('SELECT DISTINCT project FROM')) {
              return [{ project }];
            }

            if (query.includes('FROM observations o')) {
              const pendingIds = params.slice(1).filter((value): value is number => typeof value === 'number');
              if (query.includes('IN (')) {
                return observationRows.filter(row => pendingIds.includes(row.id));
              }

              const watermark = Number(params[1] ?? 0);
              return observationRows.filter(row => row.id > watermark);
            }

            if (query.includes('FROM session_summaries')) {
              return [];
            }

            if (query.includes('FROM user_prompts')) {
              return [];
            }

            return [];
          },
          get: (...params: Array<string | number>) => {
            if (query.includes('COUNT(*) as count FROM observations')) {
              return { count: observationRows.length };
            }

            if (query.includes('COUNT(*) as count FROM session_summaries')) {
              return { count: 0 };
            }

            if (query.includes('COUNT(*) as count') && query.includes('FROM user_prompts')) {
              return { count: 0 };
            }

            return { count: 0 };
          },
        };
      },
    },
  } as any;
}

describe('ChromaSync watermark gap persistence', () => {
  const project = `watermark-gap-${Date.now()}`;

  beforeEach(() => {
    process.env.CLAUDE_MEM_DATA_DIR = mkdtempSync(join(tmpdir(), 'claude-mem-watermarks-'));
    existingObservationIds = new Set<number>();
    acceptingMutations = true;
    createCollectionCalls = 0;
    onCreateCollection = null;
    addDocumentCalls.length = 0;
    addDocumentPayloads.length = 0;
    ChromaSyncState.replace(project, { observations: 0, summaries: 0, prompts: 0, pending: {} });
  });

  it('records bootstrap holes below the max embedded observation id', async () => {
    existingObservationIds = new Set([1, 3, 4]);
    const sync = new ChromaSync(project);

    await sync.bootstrapWatermarksFromChroma(project, makeStore(project, [1, 2, 3, 4]));

    expect(ChromaSyncState.get(project).observations).toBe(4);
    expect(ChromaSyncState.getPending(project, 'observations')).toEqual([2]);
  });

  it('marks a failed live observation write pending so a later write cannot orphan it (#3917)', async () => {
    ChromaSyncState.replace(project, {
      observations: 4,
      summaries: 0,
      prompts: 0,
      pending: {},
    });
    const sync = new ChromaSync(project) as ChromaSync & {
      addDocuments: (documents: Array<{ id: string }>) => Promise<number>;
    };
    const observation = {
      type: 'discovery',
      title: 'Observation',
      subtitle: null,
      facts: [],
      narrative: 'Narrative',
      concepts: [],
      files_read: [],
      files_modified: [],
    };

    // Chroma is down while observation 5 is written.
    sync.addDocuments = async () => 0;
    await sync.syncObservation(5, 'mem-5', project, observation, 5, 1_700_000_000_005, 'claude');
    expect(ChromaSyncState.get(project).observations).toBe(4);
    expect(ChromaSyncState.getPending(project, 'observations')).toEqual([5]);

    // Chroma is back for observation 6: the watermark moves past 5, but 5 stays reachable.
    sync.addDocuments = async (documents) => {
      addDocumentCalls.push(documents.map(document => document.id));
      return documents.length;
    };
    await sync.syncObservation(6, 'mem-6', project, observation, 6, 1_700_000_000_006, 'claude');
    expect(ChromaSyncState.get(project).observations).toBe(6);
    expect(ChromaSyncState.getPending(project, 'observations')).toEqual([5]);

    // The next backfill picks the orphan up through the pending list.
    await sync.ensureBackfilled(project, makeStore(project, [1, 2, 3, 4, 5, 6]));
    expect(addDocumentCalls.flat()).toContain('obs_5_narrative');
    expect(ChromaSyncState.getPending(project, 'observations')).toEqual([]);
  });

  it('marks a failed live prompt write pending and clears it once the prompt lands (#3917)', async () => {
    ChromaSyncState.replace(project, {
      observations: 0,
      summaries: 0,
      prompts: 2,
      pending: {},
    });
    const sync = new ChromaSync(project) as ChromaSync & {
      addDocuments: (documents: Array<{ id: string }>) => Promise<number>;
    };

    sync.addDocuments = async () => 0;
    await sync.syncUserPrompt(3, 'mem-3', project, 'prompt text', 3, 1_700_000_000_003, 'claude');
    expect(ChromaSyncState.get(project).prompts).toBe(2);
    expect(ChromaSyncState.getPending(project, 'prompts')).toEqual([3]);

    sync.addDocuments = async (documents) => documents.length;
    await sync.syncUserPrompt(3, 'mem-3', project, 'prompt text', 3, 1_700_000_000_003, 'claude');
    expect(ChromaSyncState.get(project).prompts).toBe(3);
    expect(ChromaSyncState.getPending(project, 'prompts')).toEqual([]);
  });

  it('marks a failed live summary write pending (#3917)', async () => {
    ChromaSyncState.replace(project, {
      observations: 0,
      summaries: 7,
      prompts: 0,
      pending: {},
    });
    const sync = new ChromaSync(project) as ChromaSync & {
      addDocuments: (documents: Array<{ id: string }>) => Promise<number>;
    };
    const summary = {
      request: 'request',
      investigated: 'investigated',
      learned: 'learned',
      completed: 'completed',
      next_steps: null,
      notes: null,
    };

    sync.addDocuments = async () => 0;
    await sync.syncSummary(8, 'mem-8', project, summary, 8, 1_700_000_000_008, 'claude');
    expect(ChromaSyncState.get(project).summaries).toBe(7);
    expect(ChromaSyncState.getPending(project, 'summaries')).toEqual([8]);

    sync.addDocuments = async (documents) => documents.length;
    await sync.syncSummary(9, 'mem-9', project, summary, 9, 1_700_000_000_009, 'claude');
    expect(ChromaSyncState.get(project).summaries).toBe(9);
    expect(ChromaSyncState.getPending(project, 'summaries')).toEqual([8]);
  });

  it('keeps pending observation ids when live sync advances past the gap', async () => {
    ChromaSyncState.replace(project, {
      observations: 4,
      summaries: 0,
      prompts: 0,
      pending: { observations: [2] },
    });
    const sync = new ChromaSync(project);

    await sync.syncObservation(
      5,
      'mem-5',
      project,
      {
        type: 'discovery',
        title: 'Observation 5',
        subtitle: null,
        facts: [],
        narrative: 'Narrative 5',
        concepts: [],
        files_read: [],
        files_modified: [],
      },
      5,
      1_700_000_000_005,
      'claude',
    );

    expect(ChromaSyncState.get(project).observations).toBe(5);
    expect(ChromaSyncState.getPending(project, 'observations')).toEqual([2]);
  });

  it('backfills pending observation ids below the current watermark', async () => {
    ChromaSyncState.replace(project, {
      observations: 5,
      summaries: 0,
      prompts: 0,
      pending: { observations: [2, 4] },
    });
    const sync = new ChromaSync(project);

    await sync.ensureBackfilled(project, makeStore(project, [1, 2, 3, 4, 5]));

    const writtenIds = addDocumentCalls.flat();
    expect(writtenIds).toContain('obs_2_narrative');
    expect(writtenIds).toContain('obs_4_narrative');
    expect(writtenIds).not.toContain('obs_5_narrative');
    expect(ChromaSyncState.getPending(project, 'observations')).toEqual([]);
    expect(ChromaSyncState.get(project).observations).toBe(5);
  });

  it('stops a backfill run after repeated batch failures instead of walking every row (#3928)', async () => {
    ChromaSyncState.replace(project, {
      observations: 0,
      summaries: 0,
      prompts: 0,
      pending: {},
    });
    const sync = new ChromaSync(project) as ChromaSync & {
      addDocuments: (documents: Array<{ id: string }>) => Promise<number>;
    };
    let attempts = 0;
    sync.addDocuments = async () => {
      attempts += 1;
      return 0; // Chroma refuses every write
    };

    await sync.ensureBackfilled(project, makeStore(project, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));

    // Three failed rows, then the run stops; the other seven are never attempted.
    expect(attempts).toBe(3);
    expect(ChromaSyncState.get(project).observations).toBe(0);
    expect(ChromaSyncState.getPending(project, 'observations')).toEqual([1, 2, 3]);

    // Once Chroma writes again the same call finishes the whole backlog.
    sync.addDocuments = async (documents) => {
      addDocumentCalls.push(documents.map(document => document.id));
      return documents.length;
    };
    await sync.ensureBackfilled(project, makeStore(project, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));

    expect(ChromaSyncState.get(project).observations).toBe(10);
    expect(ChromaSyncState.getPending(project, 'observations')).toEqual([]);
    expect(addDocumentCalls.flat()).toContain('obs_10_narrative');
  });

  it('stops a backfill run once shutdown begins and does not report it complete (#4069)', async () => {
    const sync = new ChromaSync(project) as ChromaSync & {
      addDocuments: (documents: Array<{ id: string }>) => Promise<number>;
    };
    const infoSpy = spyOn(logger, 'info');
    let attempts = 0;
    sync.addDocuments = async (documents) => {
      attempts += 1;
      // The first row lands, then the worker begins shutting down mid-sweep:
      // from here on local Chroma refuses every mutation.
      acceptingMutations = false;
      return attempts === 1 ? documents.length : 0;
    };

    try {
      const completed = await sync.ensureBackfilled(project, makeStore(project, [1, 2, 3, 4, 5]));

      // No write is attempted once shutdown has begun.
      expect(attempts).toBe(1);
      expect(ChromaSyncState.get(project).observations).toBe(1);
      expect(ChromaSyncState.getPending(project, 'observations')).toEqual([]);
      expect(infoSpy.mock.calls.some(([, message]) => message === 'Smart backfill complete')).toBe(false);
      expect(completed).toBe('shutdown');
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('does not send a row\'s remaining batches once shutdown begins mid-row (#4069)', async () => {
    const sync = new ChromaSync(project) as ChromaSync & {
      addDocuments: (documents: Array<{ id: string }>) => Promise<number>;
    };
    let attempts = 0;
    sync.addDocuments = async (documents) => {
      attempts += 1;
      acceptingMutations = false;
      return documents.length;
    };

    // A narrative and 101 facts: 102 documents, so two batches of at most 100.
    const completed = await sync.ensureBackfilled(
      project,
      makeStoreFromRows(project, [makeObservationRow(1, project, 101)])
    );

    expect(attempts).toBe(1);
    expect(ChromaSyncState.get(project).observations).toBe(0);
    expect(ChromaSyncState.getPending(project, 'observations')).toEqual([1]);
    expect(completed).toBe('shutdown');
  });

  it('does not report a run complete when shutdown refuses the last row\'s write (#4069)', async () => {
    const sync = new ChromaSync(project) as ChromaSync & {
      addDocuments: (documents: Array<{ id: string }>) => Promise<number>;
    };
    sync.addDocuments = async () => {
      // Shutdown begins while this write is in flight, so Chroma refuses it.
      acceptingMutations = false;
      return 0;
    };

    const completed = await sync.ensureBackfilled(project, makeStore(project, [1]));

    expect(ChromaSyncState.get(project).observations).toBe(0);
    expect(ChromaSyncState.getPending(project, 'observations')).toEqual([1]);
    expect(completed).toBe('shutdown');
  });

  it('does not create the collection once shutdown has begun (#4069)', async () => {
    acceptingMutations = false;

    const completed = await new ChromaSync(project).ensureBackfilled(project, makeStore(project, [1]));

    expect(createCollectionCalls).toBe(0);
    expect(completed).toBe('shutdown');
  });

  it('stops a backfill when shutdown refuses the collection creation in flight (#4069)', async () => {
    onCreateCollection = () => {
      // stop() begins while the create call is queued, so Chroma refuses it.
      acceptingMutations = false;
      throw new Error('Local Chroma mutations are unavailable after shutdown begins');
    };

    const completed = await new ChromaSync(project).ensureBackfilled(project, makeStore(project, [1]));

    expect(addDocumentCalls).toEqual([]);
    expect(ChromaSyncState.get(project).observations).toBe(0);
    expect(completed).toBe('shutdown');
  });

  it('still rejects when the collection cannot be created for another reason', async () => {
    onCreateCollection = () => {
      throw new Error('disk full');
    };

    await expect(
      new ChromaSync(project).ensureBackfilled(project, makeStore(project, [1]))
    ).rejects.toThrow('disk full');
  });

  it('does not log a shutdown-refused collection creation as a failed project (#4069)', async () => {
    const errorSpy = spyOn(logger, 'error');
    onCreateCollection = () => {
      acceptingMutations = false;
      throw new Error('Local Chroma mutations are unavailable after shutdown begins');
    };

    try {
      const completed = await ChromaSync.backfillAllProjects(makeStore(project, [1, 2]));

      expect(completed).toBe(false);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('stops bootstrapping watermarks once shutdown begins (#4069)', async () => {
    rmSync(join(process.env.CLAUDE_MEM_DATA_DIR!, 'chroma-sync-state.json'), { force: true });
    expect(ChromaSyncState.exists()).toBe(false);

    const base = makeStore(project, [1]);
    const store = {
      db: {
        prepare(query: string) {
          if (query.includes('SELECT DISTINCT project FROM')) {
            return { all: () => [{ project }, { project: `${project}-b` }, { project: `${project}-c` }] };
          }
          return base.db.prepare(query);
        },
      },
    } as any;
    const errorSpy = spyOn(logger, 'error');
    onCreateCollection = () => {
      acceptingMutations = false;
      throw new Error('Local Chroma mutations are unavailable after shutdown begins');
    };

    try {
      const completed = await ChromaSync.backfillAllProjects(store);

      // The first project's refused creation ends the bootstrap; the other
      // projects never try to create the collection again.
      expect(createCollectionCalls).toBe(1);
      expect(errorSpy).not.toHaveBeenCalled();
      expect(completed).toBe(false);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('reports a finished backfill as complete', async () => {
    const sync = new ChromaSync(project);

    expect(await sync.ensureBackfilled(project, makeStore(project, [1, 2]))).toBe('completed');
    expect(ChromaSyncState.get(project).observations).toBe(2);
  });

  it('does not report the all-projects sweep complete once shutdown has begun (#4069)', async () => {
    acceptingMutations = false;

    const completed = await ChromaSync.backfillAllProjects(makeStore(project, [1, 2, 3]));

    expect(addDocumentCalls).toEqual([]);
    expect(ChromaSyncState.get(project).observations).toBe(0);
    expect(completed).toBe(false);
  });

  it('reports the all-projects sweep complete when every project finished', async () => {
    expect(await ChromaSync.backfillAllProjects(makeStore(project, [1, 2, 3]))).toBe(true);
    expect(ChromaSyncState.get(project).observations).toBe(3);
  });

  it('resets the failure streak when a later row succeeds', async () => {
    ChromaSyncState.replace(project, {
      observations: 0,
      summaries: 0,
      prompts: 0,
      pending: {},
    });
    const sync = new ChromaSync(project) as ChromaSync & {
      addDocuments: (documents: Array<{ id: string }>) => Promise<number>;
    };
    let attempts = 0;
    sync.addDocuments = async (documents) => {
      attempts += 1;
      // Rows 1-2 fail, row 3 succeeds, rows 4-5 fail, row 6 succeeds: never three in a row.
      return attempts % 3 === 0 ? documents.length : 0;
    };

    await sync.ensureBackfilled(project, makeStore(project, [1, 2, 3, 4, 5, 6]));

    expect(attempts).toBe(6);
    expect(ChromaSyncState.getPending(project, 'observations')).toEqual([1, 2, 4, 5]);
  });

  it('keeps a split observation row pending until every batch for that row lands', async () => {
    const splitRow = makeObservationRow(1, project, 101);
    ChromaSyncState.replace(project, {
      observations: 0,
      summaries: 0,
      prompts: 0,
      pending: {},
    });
    const sync = new ChromaSync(project) as ChromaSync & {
      addDocuments: (documents: Array<{ id: string }>) => Promise<number>;
    };
    let callCount = 0;
    sync.addDocuments = async (documents) => {
      addDocumentCalls.push(documents.map(document => document.id));
      callCount += 1;
      return callCount === 2 ? 0 : documents.length;
    };

    await sync.ensureBackfilled(project, makeStoreFromRows(project, [splitRow]));

    expect(ChromaSyncState.get(project).observations).toBe(0);
    expect(ChromaSyncState.getPending(project, 'observations')).toEqual([1]);

    sync.addDocuments = async (documents) => {
      addDocumentCalls.push(documents.map(document => document.id));
      return documents.length;
    };

    await sync.ensureBackfilled(project, makeStoreFromRows(project, [splitRow]));

    expect(ChromaSyncState.get(project).observations).toBe(1);
    expect(ChromaSyncState.getPending(project, 'observations')).toEqual([]);
    expect(addDocumentCalls.some(batch => batch.includes('obs_1_fact_100'))).toBe(true);
  });

  it('backfills CJK plain-string facts and concepts without JSON parse failure', async () => {
    const cjkFact = '用户身份定位——轻量数字化改造枢纽';
    const cjkConcept = '数字化改造';
    const cjkRow = {
      ...makeObservationRow(1, project),
      title: '观察: 用户身份定位',
      facts: cjkFact,
      concepts: cjkConcept,
      narrative: '项目记录包含中文叙述',
      text: '中文观察正文',
    };
    ChromaSyncState.replace(project, {
      observations: 0,
      summaries: 0,
      prompts: 0,
      pending: {},
    });
    const sync = new ChromaSync(project);

    await sync.ensureBackfilled(project, makeStoreFromRows(project, [cjkRow]));

    const writtenIds = addDocumentCalls.flat();
    expect(writtenIds).toContain('obs_1_fact_0');
    expect(addDocumentPayloads.flatMap(payload => payload.documents)).toContain(cjkFact);
    expect(addDocumentPayloads.flatMap(payload => payload.metadatas).some(metadata => (
      metadata.concepts === cjkConcept
    ))).toBe(true);
    expect(ChromaSyncState.get(project).observations).toBe(1);
    expect(ChromaSyncState.getPending(project, 'observations')).toEqual([]);
  });

  it('preserves JSON-looking plain-string list fields without logging raw memory content', async () => {
    const secretFact = 'TREX_SECRET_OBSERVATION_TOKEN_9f3a7c_DO_NOT_LOG';
    const jsonLookingFact = `{"note":"${secretFact}"}`;
    const decodedJsonScalarConcept = '数字化改造';
    const jsonScalarConcept = JSON.stringify(decodedJsonScalarConcept);
    const malformedSecretFact = 'TREX_MALFORMED_SECRET_4b1e_DO_NOT_LOG';
    const malformedJsonFact = `{"note":"${malformedSecretFact}"`;
    const warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});
    const rowId = 1;
    const malformedRowId = 2;
    const cjkRow = {
      ...makeObservationRow(rowId, project),
      facts: jsonLookingFact,
      concepts: jsonScalarConcept,
      narrative: 'json-looking fallback row',
    };
    const malformedRow = {
      ...makeObservationRow(malformedRowId, project),
      facts: malformedJsonFact,
      narrative: 'malformed fallback row',
    };
    ChromaSyncState.replace(project, {
      observations: 0,
      summaries: 0,
      prompts: 0,
      pending: {},
    });
    const sync = new ChromaSync(project);

    try {
      await sync.ensureBackfilled(project, makeStoreFromRows(project, [cjkRow, malformedRow]));
    } finally {
      warnSpy.mockRestore();
    }

    expect(addDocumentPayloads.flatMap(payload => payload.documents)).toContain(jsonLookingFact);
    expect(addDocumentPayloads.flatMap(payload => payload.documents)).toContain(malformedJsonFact);
    expect(addDocumentPayloads.flatMap(payload => payload.metadatas).some(metadata => (
      metadata.concepts === decodedJsonScalarConcept
    ))).toBe(true);
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(secretFact);
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(malformedSecretFact);
    expect(ChromaSyncState.get(project).observations).toBe(malformedRowId);
  });
});

describe('ChromaSync title-only rows and truthful backfill outcomes (#4069)', () => {
  const project = `title-only-${Date.now()}`;

  beforeEach(() => {
    process.env.CLAUDE_MEM_DATA_DIR = mkdtempSync(join(tmpdir(), 'claude-mem-title-only-'));
    existingObservationIds = new Set<number>();
    acceptingMutations = true;
    createCollectionCalls = 0;
    onCreateCollection = null;
    addDocumentCalls.length = 0;
    addDocumentPayloads.length = 0;
    ChromaSyncState.replace(project, { observations: 0, summaries: 0, prompts: 0, pending: {} });
  });

  function titleOnlyRow(id: number, subtitle: string | null = null) {
    return { ...makeObservationRow(id, project), narrative: null, text: null, facts: '[]', subtitle };
  }

  function emptyRow(id: number) {
    return { ...titleOnlyRow(id), title: null as unknown as string };
  }

  it('indexes a title-only observation as one title document and advances the watermark', async () => {
    const sync = new ChromaSync(project);

    expect(await sync.ensureBackfilled(project, makeStoreFromRows(project, [titleOnlyRow(1, 'the subtitle')])))
      .toBe('completed');

    expect(addDocumentPayloads).toHaveLength(1);
    expect(addDocumentPayloads[0].ids).toEqual(['obs_1_title']);
    expect(addDocumentPayloads[0].documents).toEqual(['Observation 1\nthe subtitle']);
    expect(addDocumentPayloads[0].metadatas[0]).toMatchObject({ field_type: 'title', sqlite_id: 1 });
    expect(ChromaSyncState.get(project).observations).toBe(1);
    expect(ChromaSyncState.getPending(project, 'observations')).toEqual([]);
  });

  it('indexes a title-only observation on the live path too', async () => {
    const sync = new ChromaSync(project);

    await sync.syncObservation(5, 'mem-5', project, {
      type: 'discovery',
      title: 'Only a title',
      subtitle: null,
      facts: [],
      narrative: null,
      concepts: [],
      files_read: [],
      files_modified: [],
    } as any, 5, 1_700_000_000_005, 'claude');

    expect(addDocumentCalls.flat()).toEqual(['obs_5_title']);
    expect(ChromaSyncState.get(project).observations).toBe(5);
  });

  it('drains rows with no title and no body, and counts them', async () => {
    const infoSpy = spyOn(logger, 'info');
    try {
      const sync = new ChromaSync(project);

      expect(await sync.ensureBackfilled(project, makeStoreFromRows(project, [emptyRow(1), emptyRow(2)])))
        .toBe('completed');

      expect(addDocumentCalls).toEqual([]);
      expect(ChromaSyncState.get(project).observations).toBe(2);
      expect(ChromaSyncState.getPending(project, 'observations')).toEqual([]);
      const completion = infoSpy.mock.calls.find(([, message]) => message === 'Smart backfill complete');
      expect(completion?.[2]).toMatchObject({ emptyRows: 2 });
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('requeues title-only rows an older version skipped below the watermark, once', async () => {
    // An older version advanced the watermark to 3 while writing nothing for
    // title-only row 2: it is neither indexed nor pending.
    ChromaSyncState.replace(project, { observations: 3, summaries: 0, prompts: 0, pending: {} });
    const rows = [makeObservationRow(1, project), titleOnlyRow(2), makeObservationRow(3, project)];
    const store = makeStoreFromRows(project, rows);
    const sync = new ChromaSync(project);

    expect(await sync.ensureBackfilled(project, store)).toBe('completed');

    expect(addDocumentCalls).toEqual([['obs_2_title']]);
    expect(ChromaSyncState.getPending(project, 'observations')).toEqual([]);
    expect(ChromaSyncState.isTitleOnlyRequeued(project)).toBe(true);

    // The requeue runs once per project, not on every sweep.
    expect(await sync.ensureBackfilled(project, store)).toBe('completed');
    expect(addDocumentCalls).toEqual([['obs_2_title']]);
  });

  it('reports write_failures on repeated write failures without advancing the watermark', async () => {
    const store = makeStoreFromRows(project, [1, 2, 3].map(id => makeObservationRow(id, project)));
    const sync = new ChromaSync(project) as ChromaSync & {
      addDocuments: (documents: Array<{ id: string }>) => Promise<number>;
    };
    sync.addDocuments = async () => 0; // Chroma refusing writes

    expect(await sync.ensureBackfilled(project, store)).toBe('write_failures');
    // Nothing landed: the watermark must not advance past unwritten rows.
    expect(ChromaSyncState.get(project).observations).toBe(0);
    expect(ChromaSyncState.getPending(project, 'observations')).toEqual([1, 2, 3]);
  });

  it('reports write_failures when an isolated row fails but later rows succeed', async () => {
    const store = makeStoreFromRows(project, [1, 2, 3].map(id => makeObservationRow(id, project)));
    const sync = new ChromaSync(project) as ChromaSync & {
      addDocuments: (documents: Array<{ id: string }>) => Promise<number>;
    };
    let calls = 0;
    // Only the first row's batch fails; the rest land. The failed row stays
    // pending for the next run, and the project must not be claimed complete.
    sync.addDocuments = async (documents) => {
      calls += 1;
      return calls === 1 ? 0 : documents.length;
    };

    expect(await sync.ensureBackfilled(project, store)).toBe('write_failures');
    expect(ChromaSyncState.get(project).observations).toBe(3);
    expect(ChromaSyncState.getPending(project, 'observations')).toEqual([1]);
  });

  it('keeps one project\'s write failures from stopping another project running alongside it', async () => {
    // Several projects share one ChromaSync instance during a sweep, so the
    // abort must not live on the instance.
    const failing = `${project}-failing`;
    ChromaSyncState.replace(failing, { observations: 0, summaries: 0, prompts: 0, pending: {} });
    const sync = new ChromaSync('claude-mem') as ChromaSync & {
      addDocuments: (documents: Array<{ id: string; metadata: { project?: unknown } }>) => Promise<number>;
    };
    sync.addDocuments = async (documents) => (documents[0]?.metadata.project === failing ? 0 : documents.length);

    // The healthy project has more rows than the failing one needs to give up,
    // so it is still running when the other project aborts.
    const [failed, completed] = await Promise.all([
      sync.ensureBackfilled(failing, makeStoreFromRows(failing, [1, 2, 3].map(id => makeObservationRow(id, failing)))),
      sync.ensureBackfilled(project, makeStoreFromRows(project, [1, 2, 3, 4, 5, 6].map(id => makeObservationRow(id, project)))),
    ]);

    expect(failed).toBe('write_failures');
    expect(completed).toBe('completed');
    expect(ChromaSyncState.get(project).observations).toBe(6);
  });
});

describe('ChromaSync backfill project enumeration (#4069)', () => {
  it('backfills projects that only have summaries, only prompts, or an empty project name', async () => {
    process.env.CLAUDE_MEM_DATA_DIR = mkdtempSync(join(tmpdir(), 'claude-mem-enumeration-'));
    // An existing state file skips the one-time bootstrap from Chroma.
    ChromaSyncState.replace('enumeration-seed', { observations: 0, summaries: 0, prompts: 0 });
    acceptingMutations = true;

    const store = new SessionStore(':memory:');
    const seen: string[] = [];
    const ensureSpy = spyOn(ChromaSync.prototype, 'ensureBackfilled').mockImplementation(async (project: string) => {
      seen.push(project);
      return 'completed';
    });
    const observation = {
      type: 'discovery', title: 'A title', subtitle: null, facts: [], narrative: 'A narrative',
      concepts: [], files_read: [], files_modified: [],
    };
    function session(contentSessionId: string, project: string, memorySessionId: string): void {
      store.updateMemorySessionId(store.createSDKSession(contentSessionId, project, 'first prompt'), memorySessionId);
    }

    try {
      session('content-obs', 'obs-only', 'mem-obs');
      store.storeObservation('mem-obs', 'obs-only', observation);
      // The summary's project differs from its session's, so only session_summaries names it.
      session('content-sum', 'summary-session', 'mem-sum');
      store.storeSummary('mem-sum', 'summary-only', {
        request: 'r', investigated: 'i', learned: 'l', completed: 'c', next_steps: 'n', notes: null,
      });
      // Only a session-joined prompt names this project.
      session('content-prompt', 'prompt-only', 'mem-prompt');
      store.saveUserPrompt('content-prompt', 1, 'a prompt');
      session('content-empty', 'empty-session', 'mem-empty');
      store.storeObservation('mem-empty', '', observation);

      expect(await ChromaSync.backfillAllProjects(store)).toBe(true);

      expect(seen).toEqual(expect.arrayContaining(['obs-only', 'summary-only', 'prompt-only', '']));
    } finally {
      ensureSpy.mockRestore();
      store.close();
    }
  });
});
