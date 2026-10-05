import { strict as assert } from 'node:assert';
import { spyOn } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.ts';
import { SessionManager } from '../../../src/services/worker/SessionManager.ts';
import { GeminiProvider } from '../../../src/services/worker/GeminiProvider.ts';
import { ModeManager } from '../../../src/services/domain/ModeManager.ts';
import { SettingsDefaultsManager } from '../../../src/shared/SettingsDefaultsManager.ts';

const scenario = process.argv[2];
const oversized = scenario !== 'normal-control';
const enabled = scenario !== 'active-compression-control';
const store = new SessionStore(':memory:');
const db: any = { getSessionStore: () => store, getSessionById: (id: number) => store.getSessionById(id), getChromaSync: () => null, getCloudSync: () => null };
const manager = new SessionManager(db);
const id = store.createSDKSession('owned-pacing-compression', 'owned-project', 'Inspect owned file');
const session = manager.initializeSession(id);
for (let index = 0; index < 2; index++) manager.queueObservation(id, { tool_name: 'Read', tool_input: { file_path: `owned-${index}.ts` }, tool_response: index === 1 && oversized ? 'owned payload '.repeat(2500) : 'owned text', prompt_number: 1, cwd: process.env.CLAUDE_MEM_DATA_DIR! });
const mode = ModeManager.getInstance() as any;
const oldMode = mode.activeMode, oldModeId = mode.activeModeId;
mode.loadMode('code');
const observations: number[] = [];
let compressionRequests = 0;
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const body: any = await request.json();
  const text = body.contents?.[0]?.parts?.[0]?.text ?? '';
  if (text.startsWith('Condense the tool payload')) {
    compressionRequests++;
    await Bun.sleep(1200); // A started request outlives its caller's 500ms deadline.
    return Response.json({ candidates: [{ content: { parts: [{ text: 'owned condensed text' }] } }] });
  }
  observations.push(performance.now());
  return Response.json({ candidates: [{ content: { parts: [{ text: `<observation><type>discovery</type><title>Owned pacing ${observations.length}</title></observation>` }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 } });
}});
const settings = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({ ...SettingsDefaultsManager.getAllDefaults(), CLAUDE_MEM_GEMINI_API_KEY: 'owned-key', CLAUDE_MEM_GEMINI_MODEL: 'gemini-flash-lite-latest', CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED: String(enabled), CLAUDE_MEM_FIELD_OPTIMIZE_TIMEOUT_MS: '500', CLAUDE_MEM_OBSERVE_BARE_PROMPTS: 'false', CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED: 'false' }));
const realFetch = globalThis.fetch;
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
  assert.ok(String(input).startsWith('https://generativelanguage.googleapis.com/'));
  return realFetch(server.url, init);
});
try {
  await new GeminiProvider(db, manager).startSession(session, { broadcastProcessingStatus() { if (manager.getTotalQueueDepth() === 0) session.abortController.abort(); } } as any);
  const rows = (store.db.query('SELECT COUNT(*) AS count FROM observations').get() as any).count;
  const gap = observations[1] - observations[0];
  console.log(JSON.stringify({ scenario, observations, gap, compressionRequests, rows, pending: manager.getTotalQueueDepth() }));
  assert.equal(observations.length, 2); assert.equal(rows, 2); assert.equal(manager.getTotalQueueDepth(), 0);
  if (enabled) {
    assert.equal(compressionRequests, 0, 'expired compression must not send a request');
    assert.ok(gap >= 4000 && gap < 6000, `Healthy observation delayed ${gap.toFixed(1)}ms by an unused pacing slot`);
  } else {
    assert.equal(compressionRequests, 1, 'disabled pacing must allow the active compression attempt');
    assert.ok(gap >= 450 && gap < 1500, `Active compression deadline took ${gap.toFixed(1)}ms`);
  }
} finally {
  session.abortController.abort(); fetchSpy.mockRestore(); settings.mockRestore(); server.stop(true);
  manager.removeSessionImmediate(id); store.close(); mode.activeMode = oldMode; mode.activeModeId = oldModeId;
}
