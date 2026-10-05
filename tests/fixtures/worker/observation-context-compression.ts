import { strict as assert } from 'node:assert';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionManager } from '../../../src/services/worker/SessionManager.js';
import { GeminiProvider } from '../../../src/services/worker/GeminiProvider.js';
import { ClaudeProvider } from '../../../src/services/worker/ClaudeProvider.js';
import { processAgentResponse, snapshotResponseContext } from '../../../src/services/worker/agents/ResponseProcessor.js';
import { ModeManager } from '../../../src/services/domain/ModeManager.js';
import { SettingsDefaultsManager } from '../../../src/shared/SettingsDefaultsManager.js';
import type { DatabaseManager } from '../../../src/services/worker/DatabaseManager.js';
import type { ActiveSession, SDKUserMessage } from '../../../src/services/worker-types.js';
import type { FieldCompressor } from '../../../src/services/worker/field-optimizer.js';

// Executed in a child with an owned CLAUDE_MEM_DATA_DIR before modules load.
const cleanup: Array<() => void | Promise<unknown>> = [];
try {
  const provider = process.argv[2];
  const advances = provider !== 'gemini-control';
  const loadSettings = SettingsDefaultsManager.loadFromFile;
  cleanup.push(() => { SettingsDefaultsManager.loadFromFile = loadSettings; });
  SettingsDefaultsManager.loadFromFile = () => ({ ...SettingsDefaultsManager.getAllDefaults(),
    CLAUDE_MEM_GEMINI_API_KEY: 'owned-fixture-key', CLAUDE_MEM_GEMINI_MODEL: 'gemini-flash-latest',
    CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED: 'false', CLAUDE_MEM_OBSERVE_BARE_PROMPTS: 'false',
    CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED: 'false',
  });
  const mode = ModeManager.getInstance() as unknown as { activeMode: unknown; activeModeId: unknown; loadMode(id: string): unknown };
  const oldMode = mode.activeMode, oldModeId = mode.activeModeId;
  cleanup.push(() => { mode.activeMode = oldMode; mode.activeModeId = oldModeId; });
  mode.loadMode('code');
  const store = new SessionStore(':memory:');
  cleanup.push(() => store.close());
  const db = { getSessionStore: () => store, getSessionById: (id: number) => store.getSessionById(id),
    getChromaSync: () => null, getCloudSync: () => null } as unknown as DatabaseManager;
  const manager = new SessionManager(db);
  const sid = store.createSDKSession('compression-content', 'owned-project', 'First user request');
  store.saveUserPrompt('compression-content', 1, 'First user request', sid);
  const session = manager.initializeSession(sid, 'First user request', 1);
  cleanup.push(() => { session.abortController.abort(); manager.removeSessionImmediate(sid); });
  session.memorySessionId = 'compression-memory';
  store.ensureMemorySessionIdRegistered(sid, session.memorySessionId);
  manager.queueObservation(sid, { tool_name: 'Read', tool_input: { file_path: 'src/first.ts' },
    tool_response: 'payload'.repeat(3000), prompt_number: 1 });
  let compressed = 0, observed = 0;
  const xml = '<observation><type>discovery</type><title>First request file</title></observation>';
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json() as { contents?: Array<{ parts: Array<{ text: string }> }>; text?: string };
    const text = body.text ?? body.contents?.map(item => item.parts.map(part => part.text).join('')).join('') ?? '';
    if (text.startsWith('Condense the tool payload')) {
      compressed++;
      assert.equal(session.lastPromptNumber, 1);
      if (advances) {
        store.saveUserPrompt('compression-content', 2, 'Second user request', sid);
        manager.initializeSession(sid, 'Second user request', 2);
      }
      return Response.json({ candidates: [{ content: { parts: [{ text: 'Condensed first-request payload' }] } }] });
    }
    observed++;
    return Response.json({ candidates: [{ content: { parts: [{ text: xml }] } }] });
  } });
  cleanup.push(() => server.stop(true));
  const realFetch = globalThis.fetch;
  cleanup.push(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = (input, init) => realFetch(server.url, init);
  if (provider.startsWith('gemini')) {
    await new GeminiProvider(db, manager).startSession(session, {
      broadcastProcessingStatus() { if (manager.getTotalQueueDepth() === 0) session.abortController.abort(); },
    });
    assert.equal(observed, 1);
  } else {
    const context = { current: snapshotResponseContext(session) };
    const compressor: FieldCompressor = async (text, budget) => {
      const response = await realFetch(server.url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `Condense the tool payload below to under ${budget} characters.\n${text}` }) });
      const body = await response.json() as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> };
      return { text: body.candidates[0].content.parts[0].text, truncated: false };
    };
    const claude = new ClaudeProvider(db, manager) as unknown as {
      createMessageGenerator(session: ActiveSession, cwd: { lastCwd: undefined }, captured: typeof context,
        worker: undefined, compressor: FieldCompressor): AsyncIterableIterator<SDKUserMessage>;
    };
    const iterator = claude.createMessageGenerator(session, { lastCwd: undefined }, context, undefined, compressor);
    cleanup.push(async () => { session.abortController.abort(); await iterator.return?.(); });
    const next = await iterator.next();
    assert.equal(next.done, false);
    assert.ok(String(next.value.message.content).includes('Condensed first-request payload'));
    await processAgentResponse(xml, session, db, manager, undefined, 10, null, 'SDK', undefined, 'owned-model', context.current);
  }
  assert.equal(compressed, 1);
  assert.equal(session.lastPromptNumber, advances ? 2 : 1);
  assert.deepEqual(store.db.query('SELECT title, prompt_number FROM observations').all(),
    [{ title: 'First request file', prompt_number: 1 }]);
  assert.equal(manager.getTotalQueueDepth(), 0);
} finally {
  for (const release of cleanup.reverse()) await release();
}
