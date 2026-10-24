import { strict as assert } from 'node:assert';
import { spyOn } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.ts';
import { SessionManager } from '../../../src/services/worker/SessionManager.ts';
import { GeminiProvider, GEMINI_RPM_LIMITS } from '../../../src/services/worker/GeminiProvider.ts';
import { ModeManager } from '../../../src/services/domain/ModeManager.ts';
import { SettingsDefaultsManager } from '../../../src/shared/SettingsDefaultsManager.ts';

const stall = process.argv[2] === 'stalled';
// The real pacing limiter at a higher per-model RPM: 60000 / 120 + 100 = a 600ms
// minimum spacing instead of 4100ms, so the same ordering checks run in a
// fraction of the time. The stall still outlasts two spacing slots.
GEMINI_RPM_LIMITS['gemini-flash-lite-latest'] = 120;
const minimumDelayMs = Math.ceil(60000 / 120) + 100;
const stallMs = 2 * minimumDelayMs + 400;
const store = new SessionStore(':memory:');
const db: any = { getSessionStore: () => store, getSessionById: (id: number) => store.getSessionById(id), getChromaSync: () => null, getCloudSync: () => null };
const manager = new SessionManager(db);
const mode = ModeManager.getInstance() as any;
const oldMode = mode.activeMode, oldModeId = mode.activeModeId;
mode.loadMode('code');
const arrivals: number[] = [];
const sessions = [1, 2, 3].map(index => {
  const id = store.createSDKSession(`owned-pacing-${index}`, 'owned-pacing-project', 'Inspect owned file');
  const session = manager.initializeSession(id);
  manager.queueObservation(id, { tool_name: 'Read', tool_input: '{}', tool_response: 'owned text', prompt_number: 1, cwd: process.env.CLAUDE_MEM_DATA_DIR! });
  return session;
});
const timers: ReturnType<typeof setTimeout>[] = [];
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const body: any = await request.json();
  assert.ok(body.contents.length > 0);
  arrivals.push(performance.now());
  if (stall && arrivals.length === 1) timers.push(setTimeout(() => {
    const until = performance.now() + stallMs;
    while (performance.now() < until) {} // Controlled worker suspension; no fake timers.
  }, 10));
  const session = sessions[arrivals.length - 1];
  timers.push(setTimeout(() => session.abortController.abort(), 30));
  return Response.json({ candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }] });
}});
const settings = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({ ...SettingsDefaultsManager.getAllDefaults(), CLAUDE_MEM_GEMINI_API_KEY: 'owned-key', CLAUDE_MEM_GEMINI_MODEL: 'gemini-flash-lite-latest', CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED: 'true', CLAUDE_MEM_OBSERVE_BARE_PROMPTS: 'false', CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED: 'false' }));
const realFetch = globalThis.fetch;
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
  assert.ok(String(input).startsWith('https://generativelanguage.googleapis.com/'));
  return realFetch(`http://127.0.0.1:${server.port}/generate`, init);
});
try {
  const provider = new GeminiProvider(db, manager);
  await Promise.all(sessions.map(session => provider.startSession(session)));
  const gaps = arrivals.slice(1).map((at, i) => at - arrivals[i]);
  console.log(JSON.stringify({ arrivals, gaps, pending: manager.getTotalQueueDepth() }));
  assert.equal(arrivals.length, 3);
  for (const gap of gaps) assert.ok(gap >= minimumDelayMs - 100, `Concurrent Gemini requests arrived only ${gap.toFixed(1)}ms apart`);
  assert.equal(manager.getTotalQueueDepth(), 3);
} finally {
  for (const timer of timers) clearTimeout(timer);
  fetchSpy.mockRestore(); settings.mockRestore(); server.stop(true);
  for (const session of sessions) manager.removeSessionImmediate(session.sessionDbId);
  store.close(); mode.activeMode = oldMode; mode.activeModeId = oldModeId;
}
