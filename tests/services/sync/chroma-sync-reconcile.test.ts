import { afterAll, beforeEach, describe, it, expect, mock } from 'bun:test';
import * as realChromaMcpManager from '../../../src/services/sync/ChromaMcpManager.js';

const realChromaMcpManagerSnapshot = { ...realChromaMcpManager };

const calls: Array<{ tool: string; args: any }> = [];
// Stateful stand-in for a Chroma collection so the reconcile path exercises
// real Chroma semantics: add rejects the whole batch on any existing ID,
// update ignores absent IDs, get reports which of the requested IDs exist.
const stored = new Set<string>();

mock.module('../../../src/services/sync/ChromaMcpManager.js', () => ({
  ChromaMcpManager: {
    getInstance: () => ({
      callTool: async (tool: string, args: any) => {
        calls.push({ tool, args });
        const ids: string[] = args?.ids ?? [];
        switch (tool) {
          case 'chroma_add_documents': {
            // Chroma rejects the entire batch if ANY id already exists.
            if (ids.some(id => stored.has(id))) {
              throw new Error(`IDs already exist in collection: ${ids.filter(id => stored.has(id)).join(', ')}`);
            }
            ids.forEach(id => stored.add(id));
            return {};
          }
          case 'chroma_get_documents':
            // Report only the requested IDs that actually exist.
            return { ids: ids.filter(id => stored.has(id)) };
          case 'chroma_update_documents':
            // Chroma silently ignores IDs that are not already present.
            return {};
          default:
            return {};
        }
      },
    }),
  },
}));

import { ChromaSync } from '../../../src/services/sync/ChromaSync.js';

afterAll(() => {
  mock.module('../../../src/services/sync/ChromaMcpManager.js', () => realChromaMcpManagerSnapshot);
});

beforeEach(() => {
  calls.length = 0;
  stored.clear();
});

function newSync(): ChromaSync {
  const sync = new ChromaSync('project');
  // Mark the collection as created so ensureCollectionExists() is a no-op.
  (sync as any).collectionCreated = true;
  return sync;
}

describe('ChromaSync duplicate-ID reconcile', () => {
  it('reconciles a fully-duplicate batch with an in-place update, never delete+add', async () => {
    const sync = newSync();
    const docs = [{ id: 'obs_1_narrative', document: 'hello world', metadata: { sqlite_id: 1 } }];

    // First write inserts, second collides and must reconcile in place.
    await sync.addDocuments(docs);
    calls.length = 0;
    const written = await sync.addDocuments(docs);

    expect(written).toBe(1);
    const tools = calls.map(c => c.tool);
    expect(tools).toContain('chroma_update_documents');
    // Soft-deleted HNSW nodes would otherwise accumulate in link_lists.bin.
    expect(tools).not.toContain('chroma_delete_documents');

    const update = calls.find(c => c.tool === 'chroma_update_documents');
    expect(update?.args.ids).toEqual(['obs_1_narrative']);
    expect(update?.args.documents).toEqual(['hello world']);
  });

  it('splits a mixed batch: updates the existing ID and INSERTS the new one', async () => {
    const sync = newSync();
    // Pre-seed one document so the next batch has one colliding + one new ID.
    await sync.addDocuments([{ id: 'obs_1_narrative', document: 'v1', metadata: { sqlite_id: 1 } }]);
    calls.length = 0;

    const written = await sync.addDocuments([
      { id: 'obs_1_narrative', document: 'v2', metadata: { sqlite_id: 1 } },
      { id: 'obs_2_narrative', document: 'brand new', metadata: { sqlite_id: 2 } },
    ]);

    // Both docs must count — the new one is genuinely inserted, not dropped.
    expect(written).toBe(2);
    expect(stored.has('obs_2_narrative')).toBe(true);

    const update = calls.find(c => c.tool === 'chroma_update_documents');
    const add = calls.filter(c => c.tool === 'chroma_add_documents').at(-1);
    expect(update?.args.ids).toEqual(['obs_1_narrative']);
    // The genuinely-new ID is added, not swallowed by the update.
    expect(add?.args.ids).toEqual(['obs_2_narrative']);
    expect(calls.map(c => c.tool)).not.toContain('chroma_delete_documents');
  });
});
