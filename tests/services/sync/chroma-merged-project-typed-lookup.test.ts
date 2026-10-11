import { afterAll, afterEach, describe, expect, it, mock } from 'bun:test';
import * as realChromaMcpManager from '../../../src/services/sync/ChromaMcpManager.js';

const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
const realChromaMcpManagerSnapshot = { ...realChromaMcpManager };

// Corpus with a sqlite_id shared across document types: observation and
// session_summary ids overlap, and user_prompt reuses them too (#4682). The
// fake evaluates the where clause it is given, so a doc_type pushed into it
// would select differently than the client-side filter must.
const CORPUS: Record<string, Record<string, unknown>> = {
  'obs_9_narrative': { sqlite_id: 9, doc_type: 'observation' },
  'summary_7_request': { sqlite_id: 7, doc_type: 'session_summary' },
  'prompt_7': { sqlite_id: 7, doc_type: 'user_prompt' }
};

function matches(where: any, meta: Record<string, unknown>): boolean {
  if (!where) return true;
  if (where.$and) return where.$and.every((clause: any) => matches(clause, meta));
  return Object.entries(where).every(([k, v]: [string, any]) => {
    if (v && typeof v === 'object') {
      if ('$in' in v) return v.$in.includes(meta[k]);
      return false;
    }
    return meta[k] === v;
  });
}

mock.module('../../../src/services/sync/ChromaMcpManager.js', () => ({
  ChromaMcpManager: {
    getInstance: () => ({
      callTool: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        if (name === 'chroma_create_collection') return {};

        if (name === 'chroma_get_documents') {
          const ids = Object.keys(CORPUS).filter(id => matches(args.where, CORPUS[id]));
          return {
            ids,
            metadatas: ids.map(id => ({ ...CORPUS[id] }))
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
    expect(getCall?.args.where).toEqual({ sqlite_id: { $in: [7] } });

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

  it('patches observation documents with an observation-typed client filter', async () => {
    await new ChromaSync('claude-mem').updateMergedIntoProject(
      [{ docType: 'observation', sqliteId: 9 }],
      'parent'
    );

    const getCall = calls.find(call => call.name === 'chroma_get_documents');
    expect(getCall?.args.where).toEqual({ sqlite_id: { $in: [9] } });

    const updateCall = calls.find(call => call.name === 'chroma_update_documents');
    expect(updateCall?.args.ids).toEqual(['obs_9_narrative']);
    expect(updateCall?.args.metadatas).toEqual([{
      sqlite_id: 9,
      doc_type: 'observation',
      merged_into_project: 'parent'
    }]);
  });
});
