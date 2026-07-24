import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';

import { ChromaSync } from '../../../src/services/sync/ChromaSync.js';
import { ChromaMcpManager } from '../../../src/services/sync/ChromaMcpManager.js';
import { ChromaSyncState } from '../../../src/services/sync/ChromaSyncState.js';
import { ChromaCorruptCollectionError, ChromaUnavailableError } from '../../../src/services/worker/search/errors.js';

// Corrupt-collection regression coverage (issue #3202).
//
// A collection whose HNSW segment is in a persistent failed state makes every
// chroma_add_documents call fail with the same deterministic tool-level
// error. Retrying such a write is never correct: each attempt makes the
// chroma-mcp python replay its write-ahead log in memory (observed: ~20 GB
// physical footprint within 4 minutes). The fix classifies the error at the
// point of failure, drops the corrupt collection, zeroes every project's
// watermarks (the collection is shared across projects) so the existing
// backfill pipeline re-derives it from SQLite, and surfaces a typed error
// instead of silently continuing.

const DETERMINISTIC_ERROR = new Error(
  'chroma-mcp tool "chroma_add_documents" returned error: Error executing tool chroma_add_documents: ' +
  "Failed to add documents to collection 'cm__test': Error executing plan: " +
  'Error sending backfill request to compactor: Failed to apply logs to the hnsw segment writer'
);

const chromaSyncStatics = ChromaSync as unknown as {
  backfillStore: unknown;
  backfillInProgress: boolean;
  rederivedCollections: Set<string>;
  backfillAllProjects(store: unknown): Promise<void>;
};

const managerStatics = ChromaMcpManager as unknown as { instance: unknown };
const realInstance = managerStatics.instance;
const realResetAll = ChromaSyncState.resetAll;
const realBackfillAllProjects = chromaSyncStatics.backfillAllProjects;

type CallToolMock = ReturnType<typeof mock>;

function installCallTool(impl: (toolName: string) => Promise<unknown>): CallToolMock {
  const callTool = mock((toolName: string, _args: unknown) => impl(toolName));
  managerStatics.instance = { callTool };
  return callTool;
}

function toolCalls(callTool: CallToolMock, toolName: string): number {
  return callTool.mock.calls.filter(call => call[0] === toolName).length;
}

function makeDoc(id: string) {
  return { id, document: `doc ${id}`, metadata: { sqlite_id: 1, doc_type: 'observation' } };
}

beforeEach(() => {
  chromaSyncStatics.backfillStore = null;
  chromaSyncStatics.backfillInProgress = false;
  chromaSyncStatics.rederivedCollections.clear();
  chromaSyncStatics.backfillAllProjects = mock(async () => {});
  (ChromaSyncState as { resetAll: typeof realResetAll }).resetAll = mock(() => {});
});

afterAll(() => {
  managerStatics.instance = realInstance;
  (ChromaSyncState as { resetAll: typeof realResetAll }).resetAll = realResetAll;
  chromaSyncStatics.backfillAllProjects = realBackfillAllProjects;
});

describe('ChromaSync corrupt-collection handling', () => {
  it('drops the collection, zeroes all projects\' watermarks, and throws a typed error on a deterministic write failure', async () => {
    const callTool = installCallTool(async (toolName) => {
      if (toolName === 'chroma_add_documents') {
        throw DETERMINISTIC_ERROR;
      }
      return {};
    });

    const sync = new ChromaSync('corrupt-drop');
    await expect(sync.addDocuments([makeDoc('d1')])).rejects.toBeInstanceOf(ChromaCorruptCollectionError);

    expect(toolCalls(callTool, 'chroma_delete_collection')).toBe(1);
    // The collection is shared across projects, so the drop must zero every
    // project's watermarks, not just this instance's.
    expect((ChromaSyncState.resetAll as CallToolMock).mock.calls.length).toBe(1);
  });

  it('does not treat availability errors as corruption', async () => {
    const callTool = installCallTool(async (toolName) => {
      if (toolName === 'chroma_add_documents') {
        throw new ChromaUnavailableError('chroma-mcp connection in backoff');
      }
      return {};
    });

    const sync = new ChromaSync('availability');
    expect(await sync.addDocuments([makeDoc('d1')])).toBe(0);

    expect(toolCalls(callTool, 'chroma_delete_collection')).toBe(0);
    expect((ChromaSyncState.resetAll as CallToolMock).mock.calls.length).toBe(0);
  });

  it('still reconciles duplicate-ID conflicts without dropping the collection', async () => {
    let addCalls = 0;
    const callTool = installCallTool(async (toolName) => {
      if (toolName === 'chroma_add_documents') {
        addCalls += 1;
        if (addCalls === 1) {
          throw new Error('chroma-mcp tool "chroma_add_documents" returned error: IDs already exist');
        }
        return {};
      }
      if (toolName === 'chroma_get_documents') {
        return { ids: ['d1'] };
      }
      return {};
    });

    const sync = new ChromaSync('duplicate-reconcile');
    expect(await sync.addDocuments([makeDoc('d1'), makeDoc('d2')])).toBe(2);

    expect(toolCalls(callTool, 'chroma_delete_collection')).toBe(0);
    expect(toolCalls(callTool, 'chroma_update_documents')).toBe(1);
  });

  it('invalidates every instance\'s ensure-collection cache when a corrupt collection is dropped', async () => {
    let failAdds = true;
    const callTool = installCallTool(async (toolName) => {
      if (toolName === 'chroma_add_documents' && failAdds) {
        throw DETERMINISTIC_ERROR;
      }
      return {};
    });

    const writer = new ChromaSync('generation');
    const sibling = new ChromaSync('generation');

    // Sibling caches "collection exists" before the corruption trips.
    await sibling.ensureCollectionExists();

    await expect(writer.addDocuments([makeDoc('d1')])).rejects.toBeInstanceOf(ChromaCorruptCollectionError);
    const createsBefore = toolCalls(callTool, 'chroma_create_collection');

    // The sibling must recreate the collection instead of writing into the
    // deleted one.
    failAdds = false;
    expect(await sibling.addDocuments([makeDoc('d2')])).toBe(1);
    expect(toolCalls(callTool, 'chroma_create_collection')).toBe(createsBefore + 1);
  });

  it('kicks the backfill pipeline at most once per collection per process', async () => {
    installCallTool(async (toolName) => {
      if (toolName === 'chroma_add_documents') {
        throw DETERMINISTIC_ERROR;
      }
      return {};
    });
    chromaSyncStatics.backfillStore = {};

    const sync = new ChromaSync('rederive-once');
    await expect(sync.addDocuments([makeDoc('d1')])).rejects.toBeInstanceOf(ChromaCorruptCollectionError);
    await expect(sync.addDocuments([makeDoc('d2')])).rejects.toBeInstanceOf(ChromaCorruptCollectionError);

    expect((chromaSyncStatics.backfillAllProjects as CallToolMock).mock.calls.length).toBe(1);
  });

  it('does not kick a nested backfill when the corruption trips inside a running backfill', async () => {
    installCallTool(async (toolName) => {
      if (toolName === 'chroma_add_documents') {
        throw DETERMINISTIC_ERROR;
      }
      return {};
    });
    chromaSyncStatics.backfillStore = {};
    chromaSyncStatics.backfillInProgress = true;

    const sync = new ChromaSync('during-backfill');
    await expect(sync.addDocuments([makeDoc('d1')])).rejects.toBeInstanceOf(ChromaCorruptCollectionError);

    expect((chromaSyncStatics.backfillAllProjects as CallToolMock).mock.calls.length).toBe(0);
    // The drop and watermark reset still happened — the next worker start
    // re-derives the collection.
    expect((ChromaSyncState.resetAll as CallToolMock).mock.calls.length).toBe(1);
  });
});
