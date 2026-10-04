import { expect, it, spyOn } from 'bun:test';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionManager } from '../../../src/services/worker/SessionManager.js';
import { SessionRoutes } from '../../../src/services/worker/http/routes/SessionRoutes.js';
import { claudeCodeAdapter } from '../../../src/cli/adapters/claude-code.js';
import { sessionInitHandler, setSessionInitDependenciesForTesting } from '../../../src/cli/handlers/session-init.js';
import { SettingsDefaultsManager } from '../../../src/shared/SettingsDefaultsManager.js';
import type { DatabaseManager } from '../../../src/services/worker/DatabaseManager.js';

it('does not store a Qwen continuation without submitted_prompt as a media user turn', async () => {
  const cleanup: Array<() => void | Promise<unknown>> = [];
  try {
    const cwd = mkdtempSync(join(tmpdir(), 'claude-mem-qwen-provenance-'));
    cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
    const previousHost = process.env.QWEN_PROJECT_DIR;
    cleanup.push(() => { if (previousHost === undefined) delete process.env.QWEN_PROJECT_DIR; else process.env.QWEN_PROJECT_DIR = previousHost; });
    process.env.QWEN_PROJECT_DIR = cwd;
    const settings = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => SettingsDefaultsManager.getAllDefaults());
    cleanup.push(() => settings.mockRestore());
    const store = new SessionStore(':memory:');
    cleanup.push(() => store.close());
    const dbManager = { getSessionStore: () => store, getSessionById: (id: number) => store.getSessionById(id),
      getChromaSync: () => null, getCloudSync: () => null } as unknown as DatabaseManager;
    const manager = new SessionManager(dbManager);
    cleanup.push(() => manager.shutdownAll());
    const routes = new SessionRoutes(manager, dbManager, {} as never, {} as never, {} as never,
      { broadcastNewPrompt() {}, broadcastSessionStarted() {} } as never, {} as never, {} as never);
    const app = express();
    app.use(express.json());
    routes.setupRoutes(app);
    const server = app.listen(0, '127.0.0.1');
    cleanup.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture server did not bind');
    setSessionInitDependenciesForTesting({
      shouldTrackProject: () => true,
      loadFromFileOnce: () => ({ CLAUDE_MEM_SEMANTIC_INJECT: 'false' }),
      resolveRuntimeContext: () => ({ runtime: 'worker' }),
      isWorkerFallback: () => false,
      executeWithWorkerFallback: async (apiPath, method, body) => {
        const response = await fetch(`http://127.0.0.1:${address.port}${apiPath}`, { method,
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        expect(response.ok).toBe(true);
        return response.json();
      },
    });
    cleanup.push(() => setSessionInitDependenciesForTesting());
    const submit = async (raw: Record<string, unknown>) => sessionInitHandler.execute({
      ...claudeCodeAdapter.normalizeInput({ cwd, hook_event_name: 'UserPromptSubmit', ...raw }), platform: 'claude-code',
    });
    await submit({ session_id: 'qwen-content', prompt: 'expanded model input', submitted_prompt: 'Please read the file' });
    await submit({ session_id: 'qwen-content', prompt: '' });
    const qwenRows = store.db.query('SELECT prompt_number, prompt_text FROM user_prompts WHERE content_session_id = ? ORDER BY prompt_number').all('qwen-content');
    expect(qwenRows).toEqual([{ prompt_number: 1, prompt_text: 'Please read the file' }]);
    delete process.env.QWEN_PROJECT_DIR;
    await submit({ session_id: 'claude-media-content', prompt: '' });
    const mediaRows = store.db.query('SELECT prompt_text FROM user_prompts WHERE content_session_id = ?').all('claude-media-content');
    expect(mediaRows).toEqual([{ prompt_text: '[media prompt]' }]);
  } finally {
    for (const release of cleanup.reverse()) await release();
  }
});
