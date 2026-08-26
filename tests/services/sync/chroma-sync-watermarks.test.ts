import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as realChromaMcpManager from '../../../src/services/sync/ChromaMcpManager.js';

const realChromaMcpManagerSnapshot = { ...realChromaMcpManager };

let existingObservationIds = new Set<number>();
const addDocumentCalls: string[][] = [];

mock.module('../../../src/services/sync/ChromaMcpManager.js', () => ({
  ChromaMcpManager: {
    getInstance: () => ({
      callTool: async (toolName: string, args: Record<string, unknown>) => {
        if (toolName === 'chroma_create_collection') {
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
          return {};
        }

        return {};
      },
    }),
  },
}));

import { ChromaSync } from '../../../src/services/sync/ChromaSync.js';
import { ChromaSyncState } from '../../../src/services/sync/ChromaSyncState.js';

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
            if (query.includes('SELECT id') && query.includes('FROM observations') && !query.includes('LEFT JOIN')) {
              return observationRows.map(row => ({ id: row.id }));
            }

            if (query.includes('SELECT DISTINCT project FROM observations')) {
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
    addDocumentCalls.length = 0;
    ChromaSyncState.replace(project, { observations: 0, summaries: 0, prompts: 0, pending: {} });
  });

  it('records bootstrap holes below the max embedded observation id', async () => {
    existingObservationIds = new Set([1, 3, 4]);
    const sync = new ChromaSync(project);

    await sync.bootstrapWatermarksFromChroma(project, makeStore(project, [1, 2, 3, 4]));

    expect(ChromaSyncState.get(project).observations).toBe(4);
    expect(ChromaSyncState.getPending(project, 'observations')).toEqual([2]);
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
});
