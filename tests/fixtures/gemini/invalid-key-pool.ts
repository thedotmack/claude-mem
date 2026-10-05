import { strict as assert } from 'node:assert';
import { spyOn } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.ts';
import { SessionManager } from '../../../src/services/worker/SessionManager.ts';
import { GeminiProvider } from '../../../src/services/worker/GeminiProvider.ts';
import { ModeManager } from '../../../src/services/domain/ModeManager.ts';
import { SettingsDefaultsManager } from '../../../src/shared/SettingsDefaultsManager.ts';

const scenario = process.argv[2];
const store = new SessionStore(':memory:');
const db: any = { getSessionStore: () => store, getSessionById: (id: number) => store.getSessionById(id), getChromaSync: () => null, getCloudSync: () => null };
const manager = new SessionManager(db);
const id = store.createSDKSession('owned-keypool-session', 'owned-keypool-project', 'Inspect owned file');
const session = manager.initializeSession(id);
manager.queueObservation(id, { tool_name: 'Read', tool_input: '{}', tool_response: 'owned text', prompt_number: 1, cwd: process.env.CLAUDE_MEM_DATA_DIR! });
const mode = ModeManager.getInstance() as any;
const oldMode = mode.activeMode, oldModeId = mode.activeModeId;
mode.loadMode('code');
const requests: string[] = [];
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const url = new URL(request.url);
  const key = url.searchParams.get('key')!;
  requests.push(key);
  const body: any = await request.json(); assert.ok(body.contents.length > 0);
  if (key === 'owned-refused') return Response.json({ error: { code: scenario === '401-control' ? 401 : 400, message: scenario === 'bad-request-control' ? 'Invalid argument: malformed request' : 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: scenario === 'bad-request-control' ? [] : [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com' }] } }, { status: scenario === '401-control' ? 401 : 400 });
  return Response.json({ candidates: [{ content: { parts: [{ text: '<observation><type>discovery</type><title>Owned key rotation</title></observation>' }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 } });
}});
const settings = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({ ...SettingsDefaultsManager.getAllDefaults(), CLAUDE_MEM_GEMINI_API_KEY: 'owned-refused', CLAUDE_MEM_GEMINI_API_KEYS: 'owned-healthy', CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED: 'false', CLAUDE_MEM_OBSERVE_BARE_PROMPTS: 'false', CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED: 'false' }));
const realFetch = globalThis.fetch;
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
  const url = new URL(String(input)); assert.equal(url.hostname, 'generativelanguage.googleapis.com');
  return realFetch(`http://127.0.0.1:${server.port}${url.pathname}${url.search}`, init);
});
try {
  let failure: any;
  try {
    await new GeminiProvider(db, manager).startSession(session, { broadcastProcessingStatus() { if (manager.getTotalQueueDepth() === 0) session.abortController.abort(); } } as any);
  } catch (error) { failure = error; }
  const observations = (store.db.query('SELECT COUNT(*) AS count FROM observations').get() as any).count;
  console.log(JSON.stringify({ scenario, requests, observations, pending: manager.getTotalQueueDepth(), kind: failure?.kind, abortReason: session.abortReason }));
  if (scenario === 'bad-request-control') {
    assert.deepEqual(requests, ['owned-refused']); assert.equal(failure?.kind, 'unrecoverable'); assert.equal(observations, 0);
  } else {
    assert.equal(failure, undefined);
    assert.deepEqual(requests, ['owned-refused', 'owned-healthy']);
    assert.equal(observations, 1); assert.equal(manager.getTotalQueueDepth(), 0);
    assert.equal(session.cumulativeInputTokens, 100); assert.equal(session.cumulativeOutputTokens, 20);
  }
} finally {
  session.abortController.abort(); fetchSpy.mockRestore(); settings.mockRestore(); server.stop(true);
  manager.removeSessionImmediate(id); store.close(); mode.activeMode = oldMode; mode.activeModeId = oldModeId;
}
