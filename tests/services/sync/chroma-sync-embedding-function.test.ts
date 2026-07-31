import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';

// e5 migration (plans/2026-07-29-e5-embedding-migration.md, Change 3):
// ChromaSync.ensureCollectionExists must request the configured embedding
// function at chroma_create_collection time, so NEW cm__* collections are
// born with intfloat/multilingual-e5-small instead of the default MiniLM.

import * as realChromaMcpManager from '../../../src/services/sync/ChromaMcpManager.js';
import * as realSettingsDefaultsManager from '../../../src/shared/SettingsDefaultsManager.js';

const realChromaMcpManagerSnapshot = { ...realChromaMcpManager };
const realSettingsSnapshot = { ...realSettingsDefaultsManager };

let embeddingFunctionSetting = 'e5-multilingual';
const createCollectionCalls: Array<Record<string, unknown>> = [];

mock.module('../../../src/services/sync/ChromaMcpManager.js', () => ({
  ChromaMcpManager: {
    getInstance: () => ({
      callTool: async (toolName: string, args: Record<string, unknown>) => {
        if (toolName === 'chroma_create_collection') {
          createCollectionCalls.push(args);
        }
        return {};
      },
    }),
  },
}));

mock.module('../../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: {
    get: (key: string) => (key === 'CLAUDE_MEM_CHROMA_EMBEDDING_FUNCTION' ? embeddingFunctionSetting : ''),
    getInt: () => 0,
    loadFromFile: () => ({}),
  },
}));

import { ChromaSync } from '../../../src/services/sync/ChromaSync.js';

afterAll(() => {
  mock.module('../../../src/services/sync/ChromaMcpManager.js', () => realChromaMcpManagerSnapshot);
  mock.module('../../../src/shared/SettingsDefaultsManager.js', () => realSettingsSnapshot);
});

describe('ChromaSync.ensureCollectionExists embedding function', () => {
  beforeEach(() => {
    createCollectionCalls.length = 0;
    embeddingFunctionSetting = 'e5-multilingual';
  });

  it('passes embedding_function_name from CLAUDE_MEM_CHROMA_EMBEDDING_FUNCTION', async () => {
    const sync = new ChromaSync('some-project');
    await sync.ensureCollectionExists();

    expect(createCollectionCalls).toHaveLength(1);
    expect(createCollectionCalls[0]).toEqual({
      collection_name: 'cm__some-project',
      embedding_function_name: 'e5-multilingual',
    });
  });

  it('passes the rollback value when the setting is default', async () => {
    embeddingFunctionSetting = 'default';

    const sync = new ChromaSync('some-project');
    await sync.ensureCollectionExists();

    expect(createCollectionCalls[0].embedding_function_name).toBe('default');
  });

  it('falls back to default when the setting is empty', async () => {
    embeddingFunctionSetting = '';

    const sync = new ChromaSync('some-project');
    await sync.ensureCollectionExists();

    expect(createCollectionCalls[0].embedding_function_name).toBe('default');
  });

  it('creates the collection only once per ChromaSync instance', async () => {
    const sync = new ChromaSync('some-project');
    await sync.ensureCollectionExists();
    await sync.ensureCollectionExists();

    expect(createCollectionCalls).toHaveLength(1);
  });
});
