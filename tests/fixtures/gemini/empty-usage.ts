import { strict as assert } from 'node:assert';
import { spyOn } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionManager } from '../../../src/services/worker/SessionManager.js';
import { GeminiProvider } from '../../../src/services/worker/GeminiProvider.js';
import { ModeManager } from '../../../src/services/domain/ModeManager.js';
import { SettingsDefaultsManager } from '../../../src/shared/SettingsDefaultsManager.js';

const scenario = process.argv[2];
const store = new SessionStore(':memory:');
const db = { getSessionStore: () => store, getSessionById: (id: number) => store.getSessionById(id), getChromaSync: () => null, getCloudSync: () => null } as any;
const manager = new SessionManager(db);
const sessionId = store.createSDKSession('owned-gemini-session', 'owned-project', 'Inspect the owned file', undefined, 'claude');
const session = manager.initializeSession(sessionId);
const mode = ModeManager.getInstance() as any;
const oldMode = mode.activeMode, oldModeId = mode.activeModeId;
mode.loadMode('code');
const barePrompt = scenario === 'init';
const thinking = ['thought-only', 'text-with-thoughts', 'limit-with-thoughts'].includes(scenario);
if (!barePrompt) manager.queueObservation(sessionId, { tool_name: 'Read', tool_input: JSON.stringify({file_path:'owned.ts'}), tool_response: 'owned text', prompt_number: 1, cwd: process.env.CLAUDE_MEM_DATA_DIR! });
let requests = 0;
let abortTimer: ReturnType<typeof setTimeout> | undefined;
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const body = await request.json() as any;
  assert.ok(body.contents.length > 0);
  requests++;
  abortTimer = setTimeout(() => session.abortController.abort(), 30);
  return Response.json({
    candidates: [{ content: { parts: scenario === 'thought-only' ? [{thought:true,text:'owned reasoning'}] : scenario === 'text-with-thoughts' ? [{text:'owned non-XML answer'}] : [] }, finishReason: scenario.startsWith('limit') ? 'MAX_TOKENS' : 'SAFETY' }],
    usageMetadata: {promptTokenCount:120,candidatesTokenCount:scenario==='thought-only'?0:thinking?5:15,...(thinking?{thoughtsTokenCount:scenario==='thought-only'?15:10}:{}),totalTokenCount:135},
  });
}});
const settings = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({...SettingsDefaultsManager.getAllDefaults(), CLAUDE_MEM_GEMINI_API_KEY:'owned-key', CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED:'false', CLAUDE_MEM_OBSERVE_BARE_PROMPTS:barePrompt?'true':'false', CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED:'false'}));
const realFetch = globalThis.fetch;
const fetchSpy = spyOn(globalThis,'fetch').mockImplementation((input,init) => {
  const url=String(input); assert.ok(url.startsWith('https://generativelanguage.googleapis.com/'),`Unexpected endpoint ${url}`);
  return realFetch(`http://127.0.0.1:${server.port}/generate`,init);
});
try {
  const {GeminiProvider: Provider} = process.env.CLAUDE_MEM_GEMINI_MODULE ? await import(process.env.CLAUDE_MEM_GEMINI_MODULE) : {GeminiProvider};
  await new Provider(db,manager).startSession(session);
  console.log(JSON.stringify({scenario,requests,input:session.cumulativeInputTokens,output:session.cumulativeOutputTokens,lastUsage:session.lastUsage,lastContextTokens:session.lastContextTokens,pending:manager.getTotalQueueDepth()}));
  assert.equal(requests,1);
  assert.equal(session.cumulativeInputTokens,120);
  assert.equal(session.cumulativeOutputTokens,15);
  if (!barePrompt) { assert.deepEqual(session.lastUsage,{input:120,output:15}); assert.equal(session.lastContextTokens,120); assert.equal(manager.getTotalQueueDepth(),1); }
  assert.equal((store.db.query('SELECT COUNT(*) AS count FROM observations').get() as any).count,0);
} finally {
  if(abortTimer) clearTimeout(abortTimer);
  fetchSpy.mockRestore();settings.mockRestore();server.stop(true);
  manager.removeSessionImmediate(sessionId);store.close();mode.activeMode=oldMode;mode.activeModeId=oldModeId;
}
