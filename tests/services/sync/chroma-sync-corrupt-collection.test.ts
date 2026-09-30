import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { ChromaSync } from '../../../src/services/sync/ChromaSync.js';
import { ChromaMcpManager } from '../../../src/services/sync/ChromaMcpManager.js';
import { ChromaSyncState } from '../../../src/services/sync/ChromaSyncState.js';
import { ChromaCorruptCollectionError, ChromaUnavailableError } from '../../../src/services/worker/search/errors.js';

// Corrupt-collection coverage (#3202).
//
// A collection whose HNSW segment can no longer apply its write-ahead log
// fails every chroma_add_documents call the same way, and each attempt makes
// chroma-mcp replay the log in memory (about 20 GB within 4 minutes on the
// reporting host). Once that signature repeats on two distinct batches the
// collection is dropped and every project is rebuilt from SQLite. Any other
// tool error (embedding runtime, protobuf, one bad metadata value) must never
// drop every project's vectors.

const CORRUPT_SEGMENT_ERROR = new Error(
  'chroma-mcp tool "chroma_add_documents" returned error: Error executing tool chroma_add_documents: ' +
  "Failed to add documents to collection 'cm__claude-mem': Error executing plan: " +
  'Error sending backfill request to compactor: Failed to apply logs to the hnsw segment writer'
);

const EMBEDDING_RUNTIME_ERROR = new Error(
  'chroma-mcp tool "chroma_add_documents" returned error: Error executing tool chroma_add_documents: ' +
  '[ONNXRuntimeError] : 7 : INVALID_PROTOBUF : Load model from all-MiniLM-L6-v2 failed'
);

const statics = ChromaSync as unknown as {
  backfillStore: unknown;
  backfillInProgress: boolean;
  collectionGeneration: number;
  corruptSegmentBatches: Map<string, Set<string>>;
  droppedCollections: Set<string>;
  lastCollectionDrop: unknown;
  backfillAllProjects(store: unknown): Promise<boolean>;
};

const managerStatics = ChromaMcpManager as unknown as { instance: unknown };
const realInstance = managerStatics.instance;
const realBackfillAllProjects = statics.backfillAllProjects;

type ToolCall = { tool: string; args: Record<string, unknown> };
let toolCalls: ToolCall[] = [];

function installCallTool(impl: (tool: string, args: Record<string, unknown>) => Promise<unknown>): void {
  managerStatics.instance = {
    acceptsMutations: () => true,
    callTool: async (tool: string, args: Record<string, unknown>) => {
      toolCalls.push({ tool, args });
      return impl(tool, args);
    },
  };
}

function calls(tool: string): number {
  return toolCalls.filter(call => call.tool === tool).length;
}

function makeDoc(id: string) {
  return { id, document: `doc ${id}`, metadata: { sqlite_id: 1, doc_type: 'observation', project: 'p' } };
}

let backfillSweeps = 0;

beforeEach(() => {
  process.env.CLAUDE_MEM_DATA_DIR = mkdtempSync(join(tmpdir(), 'claude-mem-corrupt-'));
  ChromaSyncState.resetCacheForTests();
  toolCalls = [];
  backfillSweeps = 0;
  statics.backfillStore = null;
  statics.backfillInProgress = false;
  statics.corruptSegmentBatches.clear();
  statics.droppedCollections.clear();
  statics.lastCollectionDrop = null;
  statics.backfillAllProjects = async () => {
    backfillSweeps += 1;
    return true;
  };
});

afterAll(() => {
  managerStatics.instance = realInstance;
  statics.backfillAllProjects = realBackfillAllProjects;
});

describe('ChromaSync corrupt-collection handling (#3202)', () => {
  it('drops the collection only after the HNSW signature repeats on two distinct batches', async () => {
    installCallTool(async (tool) => {
      if (tool === 'chroma_add_documents') throw CORRUPT_SEGMENT_ERROR;
      if (tool === 'chroma_get_collection_count') return 1234;
      return {};
    });
    ChromaSyncState.replace('alpha', { observations: 40, summaries: 3, prompts: 7 });
    ChromaSyncState.replace('beta', { observations: 9, summaries: 0, prompts: 0 });
    const sync = new ChromaSync('claude-mem');

    // First batch: an ordinary failed write, nothing dropped yet.
    expect(await sync.addDocuments([makeDoc('d1')])).toBe(0);
    expect(calls('chroma_delete_collection')).toBe(0);

    // A second, distinct batch confirms it.
    await expect(sync.addDocuments([makeDoc('d2')])).rejects.toBeInstanceOf(ChromaCorruptCollectionError);

    expect(calls('chroma_delete_collection')).toBe(1);
    // The size was captured before the drop, for the log and health reporting.
    const countIndex = toolCalls.findIndex(call => call.tool === 'chroma_get_collection_count');
    const deleteIndex = toolCalls.findIndex(call => call.tool === 'chroma_delete_collection');
    expect(countIndex).toBeGreaterThan(-1);
    expect(countIndex).toBeLessThan(deleteIndex);
    expect(ChromaSync.getLastCollectionDrop()).toMatchObject({ collection: 'cm__claude-mem', documentCount: 1234 });
    // Every project is flagged for a rebuild from zero.
    expect(ChromaSyncState.isRebuildPending('alpha')).toBe(true);
    expect(ChromaSyncState.isRebuildPending('beta')).toBe(true);
  });

  it('does not count the same batch failing twice as confirmation', async () => {
    installCallTool(async (tool) => {
      if (tool === 'chroma_add_documents') throw CORRUPT_SEGMENT_ERROR;
      return {};
    });
    const sync = new ChromaSync('claude-mem');

    expect(await sync.addDocuments([makeDoc('same')])).toBe(0);
    expect(await sync.addDocuments([makeDoc('same')])).toBe(0);

    expect(calls('chroma_delete_collection')).toBe(0);
  });

  it('starts the confirmation over after a write lands', async () => {
    let failNext = true;
    installCallTool(async (tool) => {
      if (tool === 'chroma_add_documents') {
        if (failNext) throw CORRUPT_SEGMENT_ERROR;
        return {};
      }
      return {};
    });
    const sync = new ChromaSync('claude-mem');

    expect(await sync.addDocuments([makeDoc('d1')])).toBe(0);
    failNext = false;
    expect(await sync.addDocuments([makeDoc('d2')])).toBe(1);
    failNext = true;
    expect(await sync.addDocuments([makeDoc('d3')])).toBe(0);

    expect(calls('chroma_delete_collection')).toBe(0);
  });

  it('never drops the collection for other tool errors such as an embedding-runtime failure', async () => {
    installCallTool(async (tool) => {
      if (tool === 'chroma_add_documents') throw EMBEDDING_RUNTIME_ERROR;
      return {};
    });
    const sync = new ChromaSync('claude-mem');

    for (const id of ['d1', 'd2', 'd3', 'd4']) {
      expect(await sync.addDocuments([makeDoc(id)])).toBe(0);
    }

    expect(calls('chroma_delete_collection')).toBe(0);
  });

  it('does not treat availability errors as corruption', async () => {
    installCallTool(async (tool) => {
      if (tool === 'chroma_add_documents') throw new ChromaUnavailableError('chroma-mcp connection in backoff');
      return {};
    });
    const sync = new ChromaSync('claude-mem');

    expect(await sync.addDocuments([makeDoc('d1')])).toBe(0);
    expect(await sync.addDocuments([makeDoc('d2')])).toBe(0);

    expect(calls('chroma_delete_collection')).toBe(0);
  });

  it('still reconciles duplicate-ID conflicts without dropping the collection', async () => {
    let addCalls = 0;
    installCallTool(async (tool) => {
      if (tool === 'chroma_add_documents') {
        addCalls += 1;
        if (addCalls === 1) {
          throw new Error('chroma-mcp tool "chroma_add_documents" returned error: IDs already exist');
        }
        return {};
      }
      if (tool === 'chroma_get_documents') return { ids: ['d1'] };
      return {};
    });
    const sync = new ChromaSync('claude-mem');

    expect(await sync.addDocuments([makeDoc('d1'), makeDoc('d2')])).toBe(2);

    expect(calls('chroma_delete_collection')).toBe(0);
    expect(calls('chroma_update_documents')).toBe(1);
  });

  it('makes every instance recreate the collection instead of writing into the dropped one', async () => {
    let failAdds = true;
    installCallTool(async (tool) => {
      if (tool === 'chroma_add_documents' && failAdds) throw CORRUPT_SEGMENT_ERROR;
      return {};
    });
    const writer = new ChromaSync('claude-mem');
    const sibling = new ChromaSync('claude-mem');
    await sibling.ensureCollectionExists();

    await writer.addDocuments([makeDoc('d1')]);
    await expect(writer.addDocuments([makeDoc('d2')])).rejects.toBeInstanceOf(ChromaCorruptCollectionError);
    const createsBefore = calls('chroma_create_collection');

    failAdds = false;
    expect(await sibling.addDocuments([makeDoc('d3')])).toBe(1);
    expect(calls('chroma_create_collection')).toBe(createsBefore + 1);
  });

  it('drops a collection at most once per process', async () => {
    installCallTool(async (tool) => {
      if (tool === 'chroma_add_documents') throw CORRUPT_SEGMENT_ERROR;
      return {};
    });
    const sync = new ChromaSync('claude-mem');

    await sync.addDocuments([makeDoc('d1')]);
    await expect(sync.addDocuments([makeDoc('d2')])).rejects.toBeInstanceOf(ChromaCorruptCollectionError);
    // The rebuilt collection fails the same way: Chroma itself is broken.
    expect(await sync.addDocuments([makeDoc('d3')])).toBe(0);
    expect(await sync.addDocuments([makeDoc('d4')])).toBe(0);

    expect(calls('chroma_delete_collection')).toBe(1);
  });

  it('starts a rebuild sweep when none is running, and leaves a running sweep to restart itself', async () => {
    installCallTool(async (tool) => {
      if (tool === 'chroma_add_documents') throw CORRUPT_SEGMENT_ERROR;
      return {};
    });
    statics.backfillStore = {};
    const sync = new ChromaSync('claude-mem');

    await sync.addDocuments([makeDoc('d1')]);
    await expect(sync.addDocuments([makeDoc('d2')])).rejects.toBeInstanceOf(ChromaCorruptCollectionError);
    expect(backfillSweeps).toBe(1);

    // A second collection dropped while a sweep runs: the sweep restarts itself.
    statics.backfillInProgress = true;
    const other = new ChromaSync('other-tenant');
    await other.addDocuments([makeDoc('o1')]);
    await expect(other.addDocuments([makeDoc('o2')])).rejects.toBeInstanceOf(ChromaCorruptCollectionError);
    expect(backfillSweeps).toBe(1);
  });
});

describe('ChromaSync rebuild after a dropped collection (#3202)', () => {
  function makeStore(project: string, ids: number[]) {
    const rows = ids.map(id => ({
      id,
      memory_session_id: `mem-${id}`,
      project,
      merged_into_project: null,
      platform_source: 'claude',
      text: null,
      type: 'discovery',
      title: `Observation ${id}`,
      subtitle: null,
      facts: '[]',
      narrative: `Narrative ${id}`,
      concepts: '[]',
      files_read: '[]',
      files_modified: '[]',
      prompt_number: id,
      created_at_epoch: 1_700_000_000_000 + id,
    }));
    return {
      db: {
        prepare(query: string) {
          return {
            all: (...params: Array<string | number>) => {
              if (query.includes('FROM observations o')) {
                if (query.includes('IN (')) {
                  const wanted = params.slice(1);
                  return rows.filter(row => wanted.includes(row.id));
                }
                return rows.filter(row => row.id > Number(params[1] ?? 0));
              }
              return [];
            },
            get: () => ({ count: rows.length }),
          };
        },
      },
    } as any;
  }

  it('rebuilds a flagged project from zero even after a live write bumped its watermark', async () => {
    const written: string[] = [];
    installCallTool(async (tool, args) => {
      if (tool === 'chroma_add_documents') written.push(...(args.ids as string[]));
      return {};
    });
    // The drop flagged the project; a live write then bumped it to 5.
    ChromaSyncState.replace('proj', { observations: 3, summaries: 0, prompts: 0, rebuildPending: true });
    ChromaSyncState.bump('proj', 'observations', 5);

    const outcome = await new ChromaSync('claude-mem').ensureBackfilled('proj', makeStore('proj', [1, 2, 3, 4, 5]));

    expect(outcome).toBe('completed');
    expect(written).toEqual(['obs_1_narrative', 'obs_2_narrative', 'obs_3_narrative', 'obs_4_narrative', 'obs_5_narrative']);
    expect(ChromaSyncState.isRebuildPending('proj')).toBe(false);
    expect(ChromaSyncState.get('proj').observations).toBe(5);
  });

  it('keeps the rebuild flag when the rebuild does not finish, so the next run rebuilds again', async () => {
    installCallTool(async (tool) => {
      if (tool === 'chroma_add_documents') throw new ChromaUnavailableError('down');
      return {};
    });
    ChromaSyncState.replace('proj', { observations: 3, summaries: 0, prompts: 0, rebuildPending: true });

    const outcome = await new ChromaSync('claude-mem').ensureBackfilled('proj', makeStore('proj', [1, 2, 3, 4]));

    expect(outcome).toBe('write_failures');
    expect(ChromaSyncState.isRebuildPending('proj')).toBe(true);
    expect(ChromaSyncState.get('proj').observations).toBe(0);
  });

  it('stops a run whose collection is dropped mid-run without bumping anything', async () => {
    let adds = 0;
    installCallTool(async (tool) => {
      if (tool === 'chroma_add_documents') {
        adds += 1;
        if (adds >= 2) throw CORRUPT_SEGMENT_ERROR;
      }
      return {};
    });
    ChromaSyncState.replace('proj', { observations: 0, summaries: 0, prompts: 0 });

    const outcome = await new ChromaSync('claude-mem').ensureBackfilled('proj', makeStore('proj', [1, 2, 3, 4]));

    expect(outcome).toBe('collection_dropped');
    expect(calls('chroma_delete_collection')).toBe(1);
    // Row 1 landed before the drop, but the whole project is rebuilt anyway.
    expect(ChromaSyncState.isRebuildPending('proj')).toBe(true);
  });
});
