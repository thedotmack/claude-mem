import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as realChromaMcpManager from '../../../src/services/sync/ChromaMcpManager.js';

const realChromaMcpManagerSnapshot = { ...realChromaMcpManager };

const addDocumentCalls: string[][] = [];

mock.module('../../../src/services/sync/ChromaMcpManager.js', () => ({
  ChromaMcpManager: {
    getInstance: () => ({
      callTool: async (toolName: string, args: Record<string, unknown>) => {
        if (toolName === 'chroma_get_documents') {
          return { metadatas: [] };
        }
        if (toolName === 'chroma_add_documents') {
          addDocumentCalls.push((args.ids as string[]) ?? []);
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

function makeObservationRow(id: number, project: string, concepts: string) {
  return {
    id,
    memory_session_id: `mem-${id}`,
    project,
    merged_into_project: null,
    platform_source: 'claude',
    type: 'discovery',
    title: `Observation ${id}`,
    subtitle: null,
    facts: '[]',
    narrative: `Narrative ${id}`,
    concepts,
    files_read: '[]',
    files_modified: '[]',
    created_at_epoch: 1_700_000_000_000 + id,
  };
}

function makeStore(project: string, rows: ReturnType<typeof makeObservationRow>[]) {
  return {
    db: {
      prepare(query: string) {
        return {
          all: (...params: Array<string | number>) => {
            if (query.includes('SELECT DISTINCT project FROM observations')) {
              return [{ project }];
            }
            if (query.includes('FROM observations o')) {
              if (query.includes('IN (')) {
                const pendingIds = params.slice(1).filter((v): v is number => typeof v === 'number');
                return rows.filter(row => pendingIds.includes(row.id));
              }
              const watermark = Number(params[1] ?? 0);
              return rows.filter(row => row.id > watermark);
            }
            return [];
          },
          get: () => ({ count: rows.length }),
        };
      },
    },
  } as any;
}

describe('ChromaSync backfill formatting-failure recovery', () => {
  const project = `format-skip-${Date.now()}`;

  beforeEach(() => {
    process.env.CLAUDE_MEM_DATA_DIR = mkdtempSync(join(tmpdir(), 'claude-mem-format-skip-'));
    addDocumentCalls.length = 0;
    ChromaSyncState.replace(project, { observations: 0, summaries: 0, prompts: 0, pending: {} });
  });

  it('marks a skipped malformed row pending so a higher-id row cannot strand it', async () => {
    const sync = new ChromaSync(project);

    // Row 1 has a non-JSON concepts column, so formatObservationDocs throws.
    // Row 2 is valid and advances the watermark past row 1.
    await sync.ensureBackfilled(project, makeStore(project, [
      makeObservationRow(1, project, 'firebase'),
      makeObservationRow(2, project, '[]'),
    ]));

    expect(addDocumentCalls.flat()).toContain('obs_2_narrative');
    expect(addDocumentCalls.flat()).not.toContain('obs_1_narrative');
    expect(ChromaSyncState.get(project).observations).toBe(2);
    expect(ChromaSyncState.getPending(project, 'observations')).toEqual([1]);

    // Repair row 1 and rerun: the pending path re-fetches it below the
    // watermark and it is now indexed.
    addDocumentCalls.length = 0;
    await sync.ensureBackfilled(project, makeStore(project, [
      makeObservationRow(1, project, '[]'),
      makeObservationRow(2, project, '[]'),
    ]));

    expect(addDocumentCalls.flat()).toContain('obs_1_narrative');
    expect(ChromaSyncState.getPending(project, 'observations')).toEqual([]);
  });
});
