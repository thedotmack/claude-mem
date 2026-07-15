import { afterAll, describe, it, expect, mock } from 'bun:test';
import * as realChromaMcpManager from '../../../src/services/sync/ChromaMcpManager.js';

const realChromaMcpManagerSnapshot = { ...realChromaMcpManager };

const calls: Array<{ tool: string; args: any }> = [];

mock.module('../../../src/services/sync/ChromaMcpManager.js', () => ({
  ChromaMcpManager: {
    getInstance: () => ({
      callTool: async (tool: string, args: any) => {
        calls.push({ tool, args });
        // Simulate the deterministic-ID collision: the first add succeeds,
        // any subsequent add for the same IDs reports the Chroma conflict.
        if (tool === 'chroma_add_documents') {
          throw new Error('IDs already exist in collection: obs_1_narrative');
        }
        return {};
      },
    }),
  },
}));

import { ChromaSync } from '../../../src/services/sync/ChromaSync.js';

afterAll(() => {
  mock.module('../../../src/services/sync/ChromaMcpManager.js', () => realChromaMcpManagerSnapshot);
});

describe('ChromaSync duplicate-ID reconcile', () => {
  it('reconciles conflicts with an in-place update, never delete+add', async () => {
    calls.length = 0;
    const sync = new ChromaSync('project');
    // Mark the collection as created so ensureCollectionExists() is a no-op.
    (sync as any).collectionCreated = true;

    const written = await sync.addDocuments([
      { id: 'obs_1_narrative', document: 'hello world', metadata: { sqlite_id: 1 } },
    ]);

    expect(written).toBe(1);

    const tools = calls.map(c => c.tool);
    // The add is attempted first and hits the "already exist" conflict.
    expect(tools).toContain('chroma_add_documents');
    // Reconcile must happen via update, not delete — soft-deleted HNSW nodes
    // would otherwise accumulate in link_lists.bin on every resync.
    expect(tools).toContain('chroma_update_documents');
    expect(tools).not.toContain('chroma_delete_documents');

    const update = calls.find(c => c.tool === 'chroma_update_documents');
    expect(update?.args.ids).toEqual(['obs_1_narrative']);
    expect(update?.args.documents).toEqual(['hello world']);
  });
});
