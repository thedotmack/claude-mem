import { expect, it, spyOn } from 'bun:test';
import express from 'express';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { DataRoutes } from '../../../src/services/worker/http/routes/DataRoutes.js';
import { SetupScan } from '../../../src/services/prompt-import/setup-scan.js';

const SESSION = '11111111-aaaa-bbbb-cccc-000000000001';
const CUTOFF = Date.parse('2024-10-10T10:00:00.000Z');
const BEFORE = CUTOFF - 60_000;
const AFTER = CUTOFF + 60_000;

async function withDeletedSession(run: (store: SessionStore, directory: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'cmem-setup-deleted-'));
  const file = join(directory, 'memory.sqlite');
  let store = new SessionStore(file);
  const original = store.importSdkSession({ content_session_id: SESSION, memory_session_id: 'old-memory',
    project: 'deleted-history', platform_source: 'claude', user_prompt: 'Deleted old ask',
    started_at: new Date(BEFORE).toISOString(), started_at_epoch: BEFORE,
    completed_at: null, completed_at_epoch: null, status: 'completed' }).id;
  store.saveUserPrompt(SESSION, 1, 'Deleted old ask', original, undefined, undefined, BEFORE);
  const routes = new DataRoutes({} as any,
    { getSessionStore: () => store, getCloudSync: () => null, getChromaSync: () => null } as any,
    { getSession: () => undefined } as any, { broadcast() {} } as any, {} as any, Date.now());
  const app = express();
  routes.setupRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test HTTP port');
    const clock = spyOn(Date, 'now').mockReturnValue(CUTOFF);
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/sessions/claude/${SESSION}`, { method: 'DELETE' });
      expect(response.status).toBe(200);
    } finally { clock.mockRestore(); }
    // The cutoff must still apply when setup is run after a worker restart.
    store.close();
    store = new SessionStore(file);
    expect(store.getSessionDeletedAtEpochMs('claude', SESSION)).toBe(CUTOFF);
    await run(store, directory);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const resumed of [false, true]) {
  it(`keeps deleted transcript asks out of setup memory and extraction${resumed ? ' after the session resumes' : ''}`, async () => {
    await withDeletedSession(async (store, directory) => {
      const prompts = [{ text: 'Deleted old ask', at: BEFORE, id: 'old-ask' }];
      if (resumed) {
        const session = store.createSDKSession(SESSION, 'deleted-history', 'New resumed ask', undefined, 'claude', AFTER);
        store.saveUserPrompt(SESSION, 1, 'New resumed ask', session, undefined, undefined, AFTER);
        prompts.push({ text: 'New resumed ask', at: AFTER, id: 'new-ask' });
      }
      const projectDir = join(directory, '.claude', 'projects', 'deleted-history');
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, `${SESSION}.jsonl`), prompts.map(prompt => JSON.stringify({
        type: 'user', message: { role: 'user', content: prompt.text }, uuid: prompt.id,
        timestamp: new Date(prompt.at).toISOString(), origin: { kind: 'human' }, promptSource: 'typed',
        entrypoint: 'cli', cwd: '/deleted-history', sessionId: SESSION, isSidechain: false,
      })).join('\n'));
      const extracted: string[][] = [];
      const scan = new SetupScan({ getStore: () => store, now: () => CUTOFF + 86_400_000,
        scanOptions: { homeDirectory: directory, agents: ['claude-code'], resolveProject: () => 'deleted-history' },
        detectAgents: async () => [] });
      scan.setExtractor(async ownerPrompts => { extracted.push(ownerPrompts.map(prompt => prompt.text)); });
      scan.start();
      const state = await scan.finished();
      if (state.phase === 'awaiting-consent') await scan.confirmUpload(true);
      expect(store.db.prepare('SELECT prompt_text FROM user_prompts ORDER BY id').all())
        .toEqual(resumed ? [{ prompt_text: 'New resumed ask' }] : []);
      expect(state.added).toBe(0);
      expect(extracted).toEqual([resumed ? ['New resumed ask'] : []]);
      expect(state.recentPrompts.map(prompt => prompt.text)).toEqual(resumed ? ['New resumed ask'] : []);
      expect(state.agents.find(agent => agent.id === 'claude-code')?.prompts).toBe(resumed ? 1 : 0);
      if (!resumed) expect(state.phase).toBe('done');
    });
  });
}

it('uses the source timestamp and platform when importing a resumed transcript', async () => {
  await withDeletedSession(async store => {
    const prompt = { platformSource: 'claude', contentSessionId: SESSION, project: 'deleted-history',
      nativePromptId: 'exact-cutoff', promptText: 'At the cutoff', createdAtEpoch: CUTOFF,
      hookMatchWindowMs: 0, claimedHookRowIds: new Set<number>() };
    // A transcript can itself be the first source to record the resumed turn.
    expect(store.importTranscriptUserPrompt({ ...prompt, nativePromptId: 'after', promptText: 'After deletion', createdAtEpoch: AFTER }).reason).toBe('new');
    expect(store.importTranscriptUserPrompt(prompt).reason).toBe('deleted');
    expect(store.importTranscriptUserPrompt({ ...prompt, platformSource: 'codex' }).reason).toBe('new');
    expect(store.db.prepare('SELECT prompt_text FROM user_prompts ORDER BY id').all())
      .toEqual([{ prompt_text: 'After deletion' }, { prompt_text: 'At the cutoff' }]);
  });
});
