import { strict as assert } from 'node:assert';
import { mock, spyOn } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, utimesSync } from 'node:fs';
import { join, basename } from 'node:path';
import { kimiAdapter } from '../../../src/cli/adapters/kimi.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';
import { SessionManager } from '../../../src/services/worker/SessionManager.js';
import { GeminiProvider } from '../../../src/services/worker/GeminiProvider.js';
import { ingestObservation, setIngestContext } from '../../../src/services/worker/http/shared.js';
import { ModeManager } from '../../../src/services/domain/ModeManager.js';
import { SettingsDefaultsManager } from '../../../src/shared/SettingsDefaultsManager.js';
import type { DatabaseManager } from '../../../src/services/worker/DatabaseManager.js';
const workerUtils = { ...(await import('../../../src/shared/worker-utils.js')) };
// Current Kimi Read contract: MoonshotAI/kimi-code docs/en/reference/tools.md (path + read options).
const kind = process.argv[2];
const contextCase = kind.startsWith('context-');
const writeControl = kind === 'write-control';
const cleanup: Array<() => void | Promise<unknown>> = [];
try {
  const cwd = join(process.env.CLAUDE_MEM_DATA_DIR!, 'owned-project');
  mkdirSync(join(cwd, 'src'), { recursive: true });
  const relativePath = 'src/owned.ts';
  const absolutePath = join(cwd, relativePath);
  writeFileSync(absolutePath, 'owned contents\n'.repeat(160));
  const past = (Date.now() - 3600000) / 1000;
  utimesSync(absolutePath, past, past);
  const toolPath = kind.endsWith('absolute') ? absolutePath : relativePath;
  const conflicting = kind.endsWith('conflicting');
  const otherPath = 'src/other.ts';
  if (conflicting) {
    writeFileSync(join(cwd, otherPath), 'other contents\n'.repeat(160));
    utimesSync(join(cwd, otherPath), past, past);
  }
  const toolInput = kind === 'legacy-read' ? { file_path: toolPath }
    : conflicting ? { file_path: toolPath, path: otherPath, line_offset: 2, n_lines: 3 }
    : { path: toolPath, line_offset: 2, n_lines: 3 };
  const originalInput = JSON.stringify(toolInput);
  const input = kimiAdapter.normalizeInput({ hook_event_name: contextCase ? 'PreToolUse' : 'PostToolUse',
    session_id: `owned-kimi-${kind}`, cwd, tool_name: writeControl ? 'Write' : 'Read', tool_input: toolInput,
    tool_call_id: `owned-call-${kind}`, tool_output: readFileSync(absolutePath, 'utf8'),
  });
  const settings = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
    ...SettingsDefaultsManager.getAllDefaults(), CLAUDE_MEM_GEMINI_API_KEY: 'owned-fixture-key',
    CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED: 'false', CLAUDE_MEM_OBSERVE_BARE_PROMPTS: 'false',
    CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED: 'false',
  }));
  cleanup.push(() => settings.mockRestore());
  const mode = ModeManager.getInstance() as any;
  const priorMode = mode.activeMode, priorId = mode.activeModeId;
  cleanup.push(() => { mode.activeMode = priorMode; mode.activeModeId = priorId; });
  mode.loadMode('code');
  const store = new SessionStore(':memory:');
  cleanup.push(() => store.close());
  const db = { getSessionStore: () => store, getSessionById: (id: number) => store.getSessionById(id),
    getChromaSync: () => null, getCloudSync: () => null } as unknown as DatabaseManager;
  const manager = new SessionManager(db);
  const requests: string[] = [];
  const realFetch = globalThis.fetch;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const url = new URL(req.url);
    requests.push(url.pathname);
    if (url.pathname === '/api/observations/by-file') {
      const rows = new Map<number, unknown>();
      for (const candidate of url.searchParams.getAll('path')) {
        for (const row of new SessionSearch(store.db).findByFile(candidate).observations) rows.set(row.id, row);
      }
      return Response.json({ observations: [...rows.values()], count: rows.size });
    }
    await req.json();
    return Response.json({ candidates: [{ content: { parts: [{ text:
      '<observation><type>discovery</type><title>Owned Kimi read</title><narrative>File contents inspected.</narrative></observation>' }] } }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 } });
  } });
  cleanup.push(() => server.stop(true));
  if (contextCase) {
    const sid = store.createSDKSession(`prior-${kind}`, basename(cwd), 'Inspect owned file');
    store.updateMemorySessionId(sid, `memory-${kind}`);
    store.storeObservation(`memory-${kind}`, basename(cwd), { type: 'discovery', title: 'Owned prior decision', subtitle: null,
      facts: [], narrative: 'Prior inspected file', concepts: [], files_read: [toolPath], files_modified: [] }, 1);
    if (conflicting) {
      const otherSid = store.createSDKSession(`other-${kind}`, basename(cwd), 'Inspect other file');
      store.updateMemorySessionId(otherSid, `other-memory-${kind}`);
      store.storeObservation(`other-memory-${kind}`, basename(cwd), { type: 'discovery', title: 'Wrong file decision', subtitle: null,
        facts: [], narrative: 'Other inspected file', concepts: [], files_read: [otherPath], files_modified: [] }, 1);
    }
    // Keep transport owned while exercising the actual handler, SQLite lookup and dedupe gate.
    mock.module('../../../src/shared/worker-utils.js', () => ({ ...workerUtils,
      executeWithWorkerFallback: async (route: string) => (await realFetch(`http://127.0.0.1:${server.port}${route}`)).json(),
    }));
    const { fileContextHandler } = await import('../../../src/cli/handlers/file-context.js');
    const result = await fileContextHandler.execute(input);
    const output = kimiAdapter.formatOutput(result);
    console.log(JSON.stringify({ kind, requests, output }));
    assert.equal(typeof output, 'string');
    assert.ok((output as string).includes('Owned prior decision'));
    assert.ok(!(output as string).includes('Wrong file decision'));
    assert.equal(requests.filter(route => route === '/api/observations/by-file').length, 1);
  } else {
    setIngestContext({ dbManager: db, sessionManager: manager,
      eventBroadcaster: { broadcastObservationQueued() {} } as any, ensureGeneratorRunning: async () => {},
    });
    const outcome = await ingestObservation({ contentSessionId: input.sessionId!, platformSource: 'kimi', cwd,
      toolName: input.toolName!, toolInput: input.toolInput, toolResponse: input.toolResponse, toolUseId: input.toolUseId });
    assert.equal(outcome.ok, true);
    const sid = (store.db.query('SELECT id FROM sdk_sessions').get() as { id: number }).id;
    const session = manager.initializeSession(sid);
    cleanup.push(() => { session.abortController.abort(); manager.removeSessionImmediate(sid); });
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((_request, init) => realFetch(`http://127.0.0.1:${server.port}/generate`, init));
    cleanup.push(() => fetchSpy.mockRestore());
    const broadcasts: any[] = [];
    await new GeminiProvider(db, manager).startSession(session, {
      sseBroadcaster: { broadcast(event: unknown) { broadcasts.push(event); } } as any,
      broadcastProcessingStatus() { if (manager.getTotalQueueDepth() === 0) session.abortController.abort(); },
    });
    const rows = store.db.query('SELECT id, files_read, files_modified FROM observations').all() as any[];
    const lookup = new SessionSearch(store.db).findByFile(toolPath).observations;
    console.log(JSON.stringify({ kind, toolPath, rows, lookupIds: lookup.map(row => row.id) }));
    assert.equal(rows.length, 1);
    assert.deepEqual(JSON.parse(rows[0].files_read), writeControl ? [] : [toolPath]);
    assert.deepEqual(JSON.parse(rows[0].files_modified), writeControl ? [toolPath] : []);
    assert.deepEqual(lookup.map(row => row.id), [rows[0].id]);
    const live = broadcasts.find(event => event.type === 'new_observation').observation;
    assert.deepEqual(JSON.parse(live.files_read), writeControl ? [] : [toolPath]);
  }
  assert.equal(JSON.stringify(toolInput), originalInput);
} finally { for (const release of cleanup.reverse()) await release(); }
