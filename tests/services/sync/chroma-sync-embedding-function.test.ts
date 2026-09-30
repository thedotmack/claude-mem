import { afterAll, beforeEach, describe, it, expect, mock } from 'bun:test';
// Capture the current exports before mock.module mutates the live namespace, and
// re-register them in afterAll so these mocks do not leak into later files
// (bun's mock.module is process-global; mock.restore() does NOT undo it).
import * as realChromaMcpManager from '../../../src/services/sync/ChromaMcpManager.js';
import * as realSettingsDefaultsManager from '../../../src/shared/SettingsDefaultsManager.js';

const realChromaMcpManagerSnapshot = { ...realChromaMcpManager };
const realSettingsSnapshot = { ...realSettingsDefaultsManager };

const createCalls: Array<Record<string, unknown>> = [];
let settingsForTest: Record<string, string> = {};

mock.module('../../../src/services/sync/ChromaMcpManager.js', () => ({
  ChromaMcpManager: {
    getInstance: () => ({
      callTool: async (tool: string, args: Record<string, unknown>) => {
        if (tool === 'chroma_create_collection') {
          createCalls.push(args);
        }
        return {};
      },
    }),
  },
}));

// Settings are mocked (not driven through env overrides) because another test
// file may leave its own SettingsDefaultsManager mock registered.
mock.module('../../../src/shared/SettingsDefaultsManager.js', () => ({
  ...realSettingsSnapshot,
  SettingsDefaultsManager: Object.create(realSettingsSnapshot.SettingsDefaultsManager, {
    loadFromFile: { value: () => settingsForTest },
  }),
}));

import { ChromaSync } from '../../../src/services/sync/ChromaSync.js';

beforeEach(() => {
  createCalls.length = 0;
  settingsForTest = {};
});

afterAll(() => {
  mock.module('../../../src/services/sync/ChromaMcpManager.js', () => realChromaMcpManagerSnapshot);
  mock.module('../../../src/shared/SettingsDefaultsManager.js', () => realSettingsSnapshot);
});

describe('ChromaSync embedding function setting', () => {
  it('sends chroma-mcp\'s own default function when the setting is absent or default', async () => {
    await new ChromaSync('project').ensureCollectionExists();
    settingsForTest = { CLAUDE_MEM_CHROMA_EMBEDDING_FUNCTION: 'default' };
    await new ChromaSync('project').ensureCollectionExists();

    expect(createCalls.map(call => call.embedding_function_name)).toEqual(['default', 'default']);
  });

  it('forwards a configured function to collection creation', async () => {
    settingsForTest = { CLAUDE_MEM_CHROMA_EMBEDDING_FUNCTION: 'openai' };

    await new ChromaSync('project').ensureCollectionExists();

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]).toMatchObject({ collection_name: 'cm__project', embedding_function_name: 'openai' });
  });

  it('rejects a name the pinned chroma-mcp does not know instead of failing every write', async () => {
    // chroma-mcp 0.2.6 has no 'multilingual' function: sending it makes every
    // chroma_create_collection call raise, even for an existing collection.
    settingsForTest = { CLAUDE_MEM_CHROMA_EMBEDDING_FUNCTION: 'multilingual' };

    await expect(new ChromaSync('project').ensureCollectionExists()).rejects.toThrow(
      'is not an embedding function chroma-mcp supports'
    );
    expect(createCalls).toHaveLength(0);
  });
});
