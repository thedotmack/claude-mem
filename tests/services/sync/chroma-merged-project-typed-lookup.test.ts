import { afterAll, afterEach, describe, expect, it, mock } from 'bun:test';
import * as realChromaMcpManager from '../../../src/services/sync/ChromaMcpManager.js';

const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
const realChromaMcpManagerSnapshot = { ...realChromaMcpManager };
let storedDocuments: { ids: string[]; metadatas: Array<Record<string, unknown>> } | null = null;

mock.module('../../../src/services/sync/ChromaMcpManager.js', () => ({
  ChromaMcpManager: {
    getInstance: () => ({
      callTool: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        if (name === 'chroma_create_collection') return {};

        if (name === 'chroma_get_documents') {
          if (storedDocuments) return storedDocuments;
          const where = args.where as { $and?: Array<Record<string, unknown>> };
          const docType = where.$and?.find(condition => condition.doc_type)?.doc_type;
          if (docType === 'observation') {
            return {
              ids: ['obs_9_narrative'],
              metadatas: [{ sqlite_id: 9, doc_type: 'observation' }]
            };
          }
          if (docType === 'session_summary') {
            return {
              ids: ['summary_7_request'],
              metadatas: [{ sqlite_id: 7, doc_type: 'session_summary' }]
            };
          }
          return {
            ids: ['prompt_7'],
            metadatas: [{ sqlite_id: 7, doc_type: 'user_prompt' }]
          };
        }

        return {};
      }
    })
  }
}));

import { ChromaSync } from '../../../src/services/sync/ChromaSync.js';

afterEach(() => {
  calls.length = 0;
  storedDocuments = null;
});

afterAll(() => {
  mock.module('../../../src/services/sync/ChromaMcpManager.js', () => realChromaMcpManagerSnapshot);
});

describe('ChromaSync merged project hydration', () => {
  it('patches session-summary documents for summary-only adoption', async () => {
    await new ChromaSync('claude-mem').updateMergedIntoProject(
      [{ docType: 'session_summary', sqliteId: 7 }],
      'parent'
    );

    const getCall = calls.find(call => call.name === 'chroma_get_documents');
    expect(getCall?.args.where).toEqual({
      $and: [
        { doc_type: 'session_summary' },
        { sqlite_id: { $in: [7] } }
      ]
    });

    const updateCall = calls.find(call => call.name === 'chroma_update_documents');
    expect(updateCall?.args.ids).toEqual(['summary_7_request']);
    expect(updateCall?.args.metadatas).toEqual([{
      sqlite_id: 7,
      doc_type: 'session_summary',
      merged_into_project: 'parent'
    }]);
  });

  it('does not update a prompt document with a colliding sqlite ID', async () => {
    await new ChromaSync('claude-mem').updateMergedIntoProject(
      [{ docType: 'session_summary', sqliteId: 7 }],
      'parent'
    );

    expect(calls.filter(call => call.name === 'chroma_update_documents')).toHaveLength(1);
    expect(calls.find(call => call.name === 'chroma_update_documents')?.args.ids)
      .toEqual(['summary_7_request']);
  });

  it('patches observation documents with an observation-typed lookup', async () => {
    await new ChromaSync('claude-mem').updateMergedIntoProject(
      [{ docType: 'observation', sqliteId: 9 }],
      'parent'
    );

    const getCall = calls.find(call => call.name === 'chroma_get_documents');
    expect(getCall?.args.where).toEqual({
      $and: [
        { doc_type: 'observation' },
        { sqlite_id: { $in: [9] } }
      ]
    });

    const updateCall = calls.find(call => call.name === 'chroma_update_documents');
    expect(updateCall?.args.ids).toEqual(['obs_9_narrative']);
    expect(updateCall?.args.metadatas).toEqual([{
      sqlite_id: 9,
      doc_type: 'observation',
      merged_into_project: 'parent'
    }]);
  });

  it('skips the update when every document already names the merged project', async () => {
    storedDocuments = {
      ids: ['obs_9_narrative', 'obs_9_fact_0'],
      metadatas: [
        { sqlite_id: 9, doc_type: 'observation', merged_into_project: 'parent' },
        { sqlite_id: 9, doc_type: 'observation', merged_into_project: 'parent' }
      ]
    };

    await new ChromaSync('claude-mem').updateMergedIntoProject(
      [{ docType: 'observation', sqliteId: 9 }],
      'parent'
    );

    expect(calls.filter(call => call.name === 'chroma_get_documents')).toHaveLength(1);
    expect(calls.filter(call => call.name === 'chroma_update_documents')).toHaveLength(0);
  });

  it('updates only the documents whose merged project differs', async () => {
    storedDocuments = {
      ids: ['obs_9_narrative', 'obs_10_narrative', 'obs_11_narrative'],
      metadatas: [
        { sqlite_id: 9, doc_type: 'observation', merged_into_project: 'parent' },
        { sqlite_id: 10, doc_type: 'observation' },
        { sqlite_id: 11, doc_type: 'observation', merged_into_project: 'previous-parent' }
      ]
    };

    await new ChromaSync('claude-mem').updateMergedIntoProject(
      [9, 10, 11].map(sqliteId => ({ docType: 'observation' as const, sqliteId })),
      'parent'
    );

    const updateCalls = calls.filter(call => call.name === 'chroma_update_documents');
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].args.ids).toEqual(['obs_10_narrative', 'obs_11_narrative']);
    expect(updateCalls[0].args.metadatas).toEqual([
      { sqlite_id: 10, doc_type: 'observation', merged_into_project: 'parent' },
      { sqlite_id: 11, doc_type: 'observation', merged_into_project: 'parent' }
    ]);
  });
});
