import { strict as assert } from 'node:assert';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spyOn } from 'bun:test';

const version = process.argv[3];
const sessionID = 'ses_owned_resume';
const cwd = process.env.CLAUDE_MEM_DATA_DIR!;

if (process.argv[2] === 'emit') {
  // Each invocation is a new host process, with no prior plugin module state.
  const { default: plugin } = await import(process.env.CLAUDE_MEM_OPENCODE_MODULE || '../../../src/integrations/opencode-plugin/index.ts');
  const turn = Number(process.argv[4]);
  const prompt = `Owned continuation turn ${turn}`;
  if (version === 'v1') {
    const hooks = await plugin.server({ directory: cwd, client: { session: { messages: async () => ({ data: [
      { info: { role: 'assistant', time: { completed: Date.now() } }, parts: [{ type: 'text', text: `Finished turn ${turn}` }] },
    ] }) } } });
    await hooks['chat.message']({}, { message: { role: 'user', sessionID }, parts: [{ type: 'text', text: prompt }] });
    await hooks['tool.execute.after']({ tool: 'ownedTool', sessionID, callID: `owned-call-${turn}`, args: { turn } }, { output: `Owned result ${turn}`, title: 'Owned tool', metadata: {} });
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID } } });
  } else {
    const hooks = new Map<string, (event: any) => Promise<void>>();
    const register = (domain: string) => async (name: string, callback: (event: any) => Promise<void>) => {
      hooks.set(`${domain}.${name}`, callback);
      return { dispose: async () => {} };
    };
    const cleanup = await plugin.setup({ location: { directory: cwd }, tool: { hook: register('tool') }, session: { hook: register('session') } });
    try {
      await hooks.get('session.prompt')!({ sessionID, messageID: `msg_${turn}`, prompt: { text: prompt }, delivery: 'immediate' });
      await hooks.get('tool.execute.after')!({ tool: 'ownedTool', sessionID, id: `owned-call-${turn}`, input: { turn }, status: 'completed', result: { content: [{ type: 'text', text: `Owned result ${turn}` }] } });
    } finally { await cleanup(); }
  }
} else {
  const [{ default: express }, { SessionStore }, { SessionManager }, { SessionRoutes }, { setIngestContext }, { SettingsDefaultsManager }] = await Promise.all([
    import('express'), import('../../../src/services/sqlite/SessionStore.js'), import('../../../src/services/worker/SessionManager.js'),
    import('../../../src/services/worker/http/routes/SessionRoutes.js'), import('../../../src/services/worker/http/shared.js'), import('../../../src/shared/SettingsDefaultsManager.js'),
  ]);
  const store = new SessionStore(':memory:');
  const unrelated = store.createSDKSession(sessionID, 'other-platform', 'Unrelated Claude session', undefined, 'claude');
  const db: any = { getSessionStore: () => store, getSessionById: (id: number) => store.getSessionById(id), getChromaSync: () => null, getCloudSync: () => null };
  const manager = new SessionManager(db);
  const events: any = { broadcastNewPrompt() {}, broadcastSessionStarted() {}, broadcastObservationQueued() {} };
  const routes = new SessionRoutes(manager, db, {} as any, {} as any, {} as any, events, {} as any, {} as any);
  // These are real capture routes and stores; no observer model is needed to
  // check session identity or the prompt number handed to the RAM buffer.
  const generator = spyOn(routes, 'ensureGeneratorRunning').mockResolvedValue(undefined);
  const summaries = spyOn(manager, 'queueSummarize');
  setIngestContext({ dbManager: db, sessionManager: manager, eventBroadcaster: events, ensureGeneratorRunning: async () => {} });
  const app = express(); app.use(express.json()); routes.setupRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  writeFileSync(join(cwd, 'settings.json'), JSON.stringify({ ...SettingsDefaultsManager.getAllDefaults(),
    CLAUDE_MEM_WORKER_HOST: '127.0.0.1', CLAUDE_MEM_WORKER_PORT: String(address.port), CLAUDE_MEM_OBSERVE_BARE_PROMPTS: 'false', CLAUDE_MEM_MEDIA_CAPTURE_ENABLED: 'false',
  }));
  try {
    for (const turn of [1, 2]) {
      const child = Bun.spawn([process.execPath, import.meta.path, 'emit', version, String(turn)], {
        env: { ...process.env, CLAUDE_MEM_WORKER_HOST: '127.0.0.1', CLAUDE_MEM_WORKER_PORT: String(address.port) }, stdout: 'pipe', stderr: 'pipe',
      });
      const exit = await child.exited;
      const output = await new Response(child.stdout).text() + await new Response(child.stderr).text();
      assert.equal(exit, 0, output);
    }
    const sessions = store.db.query("SELECT id, content_session_id, platform_source FROM sdk_sessions WHERE platform_source = 'opencode'").all() as any[];
    const prompts = store.db.query('SELECT content_session_id, prompt_number FROM user_prompts ORDER BY id').all();
    console.log(JSON.stringify({ version, sessions, prompts }));
    assert.equal(sessions.length, 1, 'resuming one native session must not create another memory session');
    assert.equal(sessions[0].content_session_id, sessionID);
    assert.equal(sessions[0].platform_source, 'opencode');
    assert.equal(store.getSessionById(unrelated)?.user_prompt, 'Unrelated Claude session');
    assert.notEqual(sessions[0].id, unrelated);
    assert.deepEqual(prompts, [1, 2].map(prompt_number => ({ content_session_id: sessionID, prompt_number })));
    assert.equal(manager.getSession(sessions[0].id)?.lastPromptNumber, 2);
    assert.equal(manager.getMessageBuffer().peekTypes(sessions[0].id).filter(message => message.message_type === 'observation').length, 2);
    if (version === 'v1') {
      const tools = store.db.query('SELECT content_session_id, session_db_id, prompt_number FROM tool_uses ORDER BY id').all();
      assert.deepEqual(tools, [1, 2].map(prompt_number => ({ content_session_id: sessionID, session_db_id: sessions[0].id, prompt_number })));
      assert.deepEqual(summaries.mock.calls.map(call => [call[0], call[1], call[2]]), [1, 2].map(turn => [sessions[0].id, `Finished turn ${turn}`, turn]));
    }
  } finally {
    for (const { id } of store.db.query('SELECT id FROM sdk_sessions').all() as { id: number }[]) manager.removeSessionImmediate(id);
    generator.mockRestore(); summaries.mockRestore();
    await new Promise<void>(resolve => server.close(() => resolve())); store.close();
  }
}
