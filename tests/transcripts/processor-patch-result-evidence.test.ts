import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { setIngestContext } from '../../src/services/worker/http/shared.js';
import { TranscriptEventProcessor } from '../../src/services/transcripts/processor.js';
import { processAgentResponse } from '../../src/services/worker/agents/ResponseProcessor.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { spooledEntries, useTempHookSpoolDataDir } from '../helpers/temp-hook-spool.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import type { TranscriptSchema, WatchTarget } from '../../src/services/transcripts/types.js';

const schema = JSON.parse(readFileSync(join(import.meta.dir, '../../docs/transcript-watch.example.json'), 'utf8')).schemas.codex as TranscriptSchema;
let store: SessionStore;
let manager: SessionManager;
let dbManager: DatabaseManager;
let processor: TranscriptEventProcessor;
let watch: WatchTarget;
let cwd: string;
let tempSpool: ReturnType<typeof useTempHookSpoolDataDir>;
let settings: ReturnType<typeof spyOn>;
let priorMode: unknown;
let priorModeId: unknown;

beforeEach(async () => {
  tempSpool = useTempHookSpoolDataDir();
  cwd = mkdtempSync(join(tmpdir(), 'claude-mem-patch-result-'));
  settings = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
    ...SettingsDefaultsManager.getAllDefaults(),
    CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED: 'false',
  }));
  const mode = ModeManager.getInstance() as any;
  priorMode = mode.activeMode;
  priorModeId = mode.activeModeId;
  mode.loadMode('code');
  store = new SessionStore(':memory:');
  dbManager = {
    getSessionById: (id: number) => store.getSessionById(id),
    getSessionStore: () => store, getChromaSync: () => null, getCloudSync: () => null,
  } as unknown as DatabaseManager;
  manager = new SessionManager(dbManager);
  setIngestContext({
    sessionManager: manager, dbManager,
    eventBroadcaster: { broadcastObservationQueued: () => {} } as any,
    ensureGeneratorRunning: async () => {},
  });
  processor = new TranscriptEventProcessor();
  watch = { name: 'codex', path: join(cwd, 'session.jsonl'), schema };
  await processor.processEntry({ type: 'session_meta', payload: { id: 'patch-session', cwd } }, watch, schema, 'patch-session');
});

afterEach(() => {
  const sessionId = store.findSessionDbIdByContentSessionId('patch-session', 'codex');
  const session = sessionId === null ? undefined : manager.getSession(sessionId);
  if (session) {
    session.abortController.abort();
    manager.removeSessionImmediate(session.sessionDbId);
  }
  store.close();
  settings.mockRestore();
  const mode = ModeManager.getInstance() as any;
  mode.activeMode = priorMode;
  mode.activeModeId = priorModeId;
  tempSpool.restore();
  rmSync(cwd, { recursive: true, force: true });
});

const patch = '*** Begin Patch\n*** Update File: report.txt\n@@\n-before\n+after\n*** End Patch';
const use = () => ({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'patch-1', name: 'apply_patch', input: patch } });
const result = () => ({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'patch-1', output: 'Success. Updated the following files:\nM report.txt' } });

describe('Codex transcript patch capture', () => {
  it('does not invent a successful file edit while a patch has no result', async () => {
    writeFileSync(join(cwd, 'report.txt'), 'before');
    await processor.processEntry(use(), watch, schema, 'patch-session');

    expect(readFileSync(join(cwd, 'report.txt'), 'utf8')).toBe('before');
    expect(manager.getTotalQueueDepth()).toBe(0);
    expect(spooledEntries('file_edit')).toEqual([]);
  });

  it('captures the result once and preserves its patch evidence through ingest and SQLite storage', async () => {
    writeFileSync(join(cwd, 'report.txt'), 'before');
    await processor.processEntry(use(), watch, schema, 'patch-session');
    writeFileSync(join(cwd, 'report.txt'), 'after');
    await processor.processEntry(result(), watch, schema, 'patch-session');

    const sessionId = store.findSessionDbIdByContentSessionId('patch-session', 'codex')!;
    const session = manager.getSession(sessionId)!;
    expect(manager.getTotalQueueDepth()).toBe(1);
    session.memorySessionId = 'patch-memory';
    store.ensureMemorySessionIdRegistered(session.sessionDbId, session.memorySessionId);
    session.lastGeneratorSource = 'ingest';
    const messages = manager.getMessageIterator(session.sessionDbId);
    try {
      await messages.next();
      const saved = await processAgentResponse(
        '<observation><type>change</type><title>Updated report</title></observation>',
        session, dbManager, manager, undefined, 10, null, 'SDK',
      );
      const observation = store.db.query('SELECT files_modified FROM observations WHERE id = ?').get(saved!.observationIds[0]) as { files_modified: string };
      expect(JSON.parse(observation.files_modified)).toEqual(['report.txt']);
      expect(spooledEntries('file_edit')).toEqual([]);
      expect(manager.getTotalQueueDepth()).toBe(0);
    } finally {
      session.abortController.abort();
      await messages.return(undefined);
    }
  });
});
