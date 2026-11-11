import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import express from 'express';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { ChromaSync } from '../../../../src/services/sync/ChromaSync.js';
import { ChromaMcpManager } from '../../../../src/services/sync/ChromaMcpManager.js';
import { ChromaSyncState } from '../../../../src/services/sync/ChromaSyncState.js';
import { DataRoutes } from '../../../../src/services/worker/http/routes/DataRoutes.js';

const drain = async () => { for (let turn = 0; turn < 8; turn++) await setImmediate(); };
const NOW = 1_800_000_000_000;
const summary = (platform = 'claude') => ({
  memory_session_id: `exported-${platform}`, project: 'backup-project', merged_into_project: 'main-project',
  request: `Recovered ${platform} request`, investigated: null, learned: 'Recovered conclusion',
  completed: null, next_steps: null, notes: null, prompt_number: 1,
  created_at: new Date(NOW).toISOString(), created_at_epoch: NOW,
});
const prompt = (platform = 'claude') => ({
  content_session_id: 'same-content', platform_source: platform, session_db_id: 9999,
  prompt_number: 1, prompt_text: `Recovered ${platform} prompt`,
  created_at: new Date(NOW).toISOString(), created_at_epoch: NOW,
});
const session = (platform = 'claude') => ({
  content_session_id: 'same-content', platform_source: platform, memory_session_id: `exported-${platform}`,
  project: 'backup-project', user_prompt: 'Backup opening',
  started_at: new Date(NOW).toISOString(), started_at_epoch: NOW,
  completed_at: null, completed_at_epoch: null, status: 'active',
});

describe('HTTP imports enter the semantic index', () => {
  let store: SessionStore, server: Server, baseUrl: string, directory: string;
  let previousDataDir: string | undefined;
  let transportSpy: ReturnType<typeof spyOn>;
  let chroma: ChromaSync;
  let writes: number, failWrites: boolean;
  let writeGate: Promise<void> | undefined, activeWrites: number, maxActiveWrites: number;
  const documents = new Map<string, { text: string; metadata: Record<string, unknown> }>();

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'claude-mem-import-semantic-'));
    previousDataDir = process.env.CLAUDE_MEM_DATA_DIR;
    process.env.CLAUDE_MEM_DATA_DIR = directory;
    ChromaSyncState.resetCacheForTests();
    store = new SessionStore(':memory:');
    documents.clear(); writes = 0; failWrites = false;
    writeGate = undefined; activeWrites = 0; maxActiveWrites = 0;
    // Run the actual HTTP validation, SQLite writes, Chroma document formatter,
    // row serialization and checkpoints. Only the external transport is owned.
    transportSpy = spyOn(ChromaMcpManager, 'getInstance').mockReturnValue({
      acceptsMutations: () => true,
      callTool: async (tool: string, args: any) => {
        expect(store.db.inTransaction).toBe(false);
        if (tool === 'chroma_create_collection') return {};
        if (tool === 'chroma_get_documents') return { ids: [], documents: [], metadatas: [] };
        if (tool === 'chroma_add_documents' || tool === 'chroma_update_documents') {
          writes++;
          if (failWrites) throw new Error('Owned transport unavailable');
          activeWrites++;
          maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
          try {
            await writeGate;
            args.ids.forEach((id: string, index: number) => documents.set(id, {
              text: args.documents[index], metadata: args.metadatas[index],
            }));
          } finally { activeWrites--; }
          return {};
        }
        throw new Error(`Unexpected Chroma operation: ${tool}`);
      },
    } as any);
    chroma = new ChromaSync('import-semantic');
    const app = express();
    app.use(express.json());
    new DataRoutes({} as any, { getSessionStore: () => store, getChromaSync: () => chroma } as any,
      {} as any, {} as any, {} as any, Date.now()).setupRoutes(app);
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await drain();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    transportSpy.mockRestore();
    store.close();
    ChromaSyncState.resetCacheForTests();
    if (previousDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
    else process.env.CLAUDE_MEM_DATA_DIR = previousDataDir;
    rmSync(directory, { recursive: true, force: true });
  });

  async function importRows(body: unknown) {
    const response = await fetch(`${baseUrl}/api/import`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    const result = await response.json();
    await drain();
    return result;
  }

  it('indexes restored summaries and prompts using their resolved local session and platform', async () => {
    for (const platform of ['claude', 'cursor']) {
      const id = store.createSDKSession('same-content', `local-${platform}`, 'Local opening', undefined, platform);
      store.ensureMemorySessionIdRegistered(id, `local-${platform}-memory`);
    }
    const payload = {
      sessions: ['claude', 'cursor'].map(session),
      summaries: ['claude', 'cursor'].map(summary),
      prompts: ['claude', 'cursor'].map(prompt),
    };
    const result = await importRows(payload);
    expect(result.stats).toMatchObject({ sessionsSkipped: 2, summariesImported: 2, promptsImported: 2 });
    for (const [index, platform] of ['claude', 'cursor'].entries()) {
      expect(documents.get(`summary_${index + 1}_request`)).toEqual({
        text: `Recovered ${platform} request`, metadata: expect.objectContaining({
          memory_session_id: `local-${platform}-memory`, platform_source: platform,
          project: 'backup-project', merged_into_project: 'main-project', created_at_epoch: NOW,
        }),
      });
      expect(documents.get(`prompt_${index + 1}`)).toEqual({
        text: `Recovered ${platform} prompt`, metadata: expect.objectContaining({
          memory_session_id: `local-${platform}-memory`, platform_source: platform,
          project: `local-${platform}`, created_at_epoch: NOW,
        }),
      });
    }
    const previousWrites = writes;
    expect((await importRows(payload)).stats).toMatchObject({ summariesSkipped: 2, promptsSkipped: 2 });
    expect(writes).toBe(previousWrites);
  });

  it('indexes canonical persisted scalar text and isolates rejected neighbors', async () => {
    const result = await importRows({
      sessions: [session()],
      summaries: [{ ...summary(), request: 0, learned: false }, { ...summary(), memory_session_id: 'missing-parent' }],
      prompts: [{ ...prompt(), prompt_text: 123 }, { ...prompt(), prompt_number: null }],
    });
    expect(result.stats).toMatchObject({ summariesImported: 1, summariesRejected: 1, promptsImported: 1, promptsRejected: 1 });
    const stored = store.db.query('SELECT request, learned FROM session_summaries').get() as any;
    expect(documents.get('summary_1_request')?.text).toBe(stored.request);
    expect(documents.get('summary_1_learned')?.text).toBe(stored.learned);
    expect(documents.get('prompt_1')?.text).toBe('123');
    expect(documents.size).toBe(3);
  });

  it.each(['Recovered legacy observation body', 0, false])('indexes an imported text-only observation from its persisted text: %s', async text => {
    const payload = {
      sessions: [session()],
      observations: [{
        memory_session_id: 'exported-claude', project: 'backup-project',
        text, type: 'discovery', title: null, subtitle: null,
        narrative: null, facts: null, concepts: null, files_read: null, files_modified: null,
        prompt_number: 1, discovery_tokens: 0, created_at: new Date(NOW).toISOString(), created_at_epoch: NOW,
      }],
    };
    const result = await importRows(payload);
    expect(result.stats).toMatchObject({ observationsImported: 1, observationsRejected: 0 });
    const row = store.db.query('SELECT id, text FROM observations').get() as { id: number; text: string };
    ChromaSyncState.resetCacheForTests();
    expect(ChromaSyncState.get('backup-project').observations).toBe(row.id);
    expect(documents.get(`obs_${row.id}_text`)).toEqual({
      text: row.text, metadata: expect.objectContaining({ sqlite_id: row.id, field_type: 'text', project: 'backup-project' }),
    });
    const previousWrites = writes;
    expect((await importRows(payload)).stats.observationsSkipped).toBe(1);
    expect(writes).toBe(previousWrites);
  });

  it('keeps failed imported rows pending when a later live write advances the checkpoint', async () => {
    failWrites = true;
    const result = await importRows({ sessions: [session()], summaries: [summary()], prompts: [prompt()] });
    expect(result.stats).toMatchObject({ summariesImported: 1, promptsImported: 1 });
    failWrites = false;
    await chroma.syncSummary(99, 'exported-claude', 'backup-project', {
      request: 'Later live summary', investigated: null, learned: null, completed: null, next_steps: null, notes: null,
    }, 2, NOW + 1, 'claude');
    await chroma.syncUserPrompt(99, 'exported-claude', 'backup-project', 'Later live prompt', 2, NOW + 1, 'claude');
    ChromaSyncState.resetCacheForTests();
    expect(ChromaSyncState.get('backup-project')).toMatchObject({ summaries: 99, prompts: 99 });
    expect(ChromaSyncState.getPending('backup-project', 'summaries')).toContain(1);
    expect(ChromaSyncState.getPending('backup-project', 'prompts')).toContain(1);
  });

  it('bounds mixed imports and reads queued rows after revisions or deletion', async () => {
    let release!: () => void;
    writeGate = new Promise<void>(resolve => { release = resolve; });
    try {
      const result = await importRows({
        sessions: [session()], prompts: [prompt()],
        summaries: Array.from({ length: 10 }, (_, index) => ({
          ...summary(), prompt_number: index + 1, created_at_epoch: NOW + index,
        })),
      });
      expect(result.stats).toMatchObject({ summariesImported: 10, promptsImported: 1 });
      expect(writes).toBe(8);
      store.db.query('UPDATE session_summaries SET request = ? WHERE id = 9').run('Current revised request');
      store.db.query('DELETE FROM session_summaries WHERE id = 10').run();
      release();
      await drain();
      expect(documents.get('summary_9_request')?.text).toBe('Current revised request');
      expect([...documents.keys()].some(id => id.startsWith('summary_10_'))).toBe(false);
      expect(documents.get('prompt_1')?.text).toBe('Recovered claude prompt');
      expect(maxActiveWrites).toBe(8);
    } finally { release(); await drain(); }
  });
});
