import { afterAll, expect, it, spyOn } from 'bun:test';
import { installScriptedClaudeSdk } from '../fixtures/worker/scripted-claude-sdk.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';

const sdkFixture = installScriptedClaudeSdk({ eager: true });
afterAll(() => sdkFixture.restore());
const { ClaudeProvider } = await import('../../src/services/worker/ClaudeProvider.js');
const { SessionStore } = await import('../../src/services/sqlite/SessionStore.js');
const { SessionManager } = await import('../../src/services/worker/SessionManager.js');
const { SettingsDefaultsManager } = await import('../../src/shared/SettingsDefaultsManager.js');

it.each(['observation', 'override', 'summary', 'control', 'absent'])(
  'SDK served-model attribution preserves %s', async kind => {
    sdkFixture.currentSdk = null;
    const requestedModel = kind === 'control' ? 'claude-haiku-4-5-20251001' : 'haiku';
    const settings = spyOn(SettingsDefaultsManager, 'loadFromFile').mockReturnValue({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_MODEL: kind === 'override' ? 'claude-haiku-4-5-20251001' : requestedModel,
      CLAUDE_MEM_OBSERVE_BARE_PROMPTS: 'false', CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED: 'false',
    });
    const store = new SessionStore(':memory:');
    const db = {
      getSessionStore: () => store, getSessionById: (id: number) => store.getSessionById(id),
      getChromaSync: () => null, getCloudSync: () => null,
    } as unknown as DatabaseManager;
    const manager = new SessionManager(db);
    const sid = store.createSDKSession('owned-claude-content', 'owned-project', 'Read file');
    const session = manager.initializeSession(sid, 'Read file', 1);
    let run: Promise<void> | undefined;
    try {
      if (kind === 'override') session.modelOverride = 'haiku';
      if (kind === 'summary') manager.queueSummarize(sid, 'Read owned file');
      else manager.queueObservation(sid, {
        tool_name: 'Read', tool_input: { file_path: 'owned-file.ts' },
        tool_response: 'Owned contents', prompt_number: 1,
      });
      run = new ClaudeProvider(db, manager).startSession(session);
      const sdk = await sdkFixture.sdkStarted();
      await sdk.until(() => sdk.prompts.length === 1, 'queued prompt');
      const text = kind === 'summary'
        ? '<summary><request>Owned SDK model attribution</request></summary>'
        : '<observation><type>discovery</type><title>Owned SDK model attribution</title></observation>';
      sdk.frame({
        type: 'assistant', session_id: 'owned-sdk-memory',
        message: {
          ...(kind === 'absent' ? {} : { model: 'claude-haiku-4-5-20251001' }),
          content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 20 },
        },
      });
      sdk.result({ session_id: 'owned-sdk-memory' });
      sdk.end();
      await run;
      const rows = store.db.query(kind === 'summary'
        ? 'SELECT request AS title FROM session_summaries'
        : 'SELECT title, generated_by_model FROM observations').all();
      expect(manager.getTotalQueueDepth()).toBe(0);
      expect(session.lastModelId).toBe(requestedModel);
      expect(rows).toEqual([{
        title: 'Owned SDK model attribution',
        ...(kind === 'summary' ? {} : {
          generated_by_model: kind === 'absent' ? requestedModel : 'claude-haiku-4-5-20251001',
        }),
      }]);
    } finally {
      session.abortController.abort();
      await run?.catch(() => {});
      manager.removeSessionImmediate(sid);
      store.close();
      settings.mockRestore();
    }
  },
);
