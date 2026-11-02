import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = String.raw`
  import { mkdirSync, writeFileSync } from 'node:fs';
  import { join } from 'node:path';
  import { SessionStore } from './src/services/sqlite/SessionStore.ts';
  import { queryObservationsMulti, getPriorSessionMessages, cwdToDashed } from './src/services/context/ObservationCompiler.ts';
  import { generateContextWithStats } from './src/services/context/ContextBuilder.ts';
  import { ModeManager } from './src/services/domain/ModeManager.ts';
  ModeManager.getInstance().loadMode('code');
  const store = new SessionStore(join(process.env.CLAUDE_MEM_DATA_DIR, 'claude-mem.db'));
  const config = { observationTypes: new Set(['discovery']), observationConcepts: new Set(['how-it-works']), totalObservationCount: 10, mainAgentOnly: false, showLastMessage: true };
  const cwd = '/owned/project';
  const transcriptDir = join(process.env.CLAUDE_CONFIG_DIR, 'projects', cwdToDashed(cwd));
  mkdirSync(transcriptDir, { recursive: true });
  for (const [host, observer, epoch, message] of [
    ['prior-host', 'prior-observer', 1000, 'A prior user-facing response.'],
    ['current-host', 'current-observer', 2000, 'Current response should not be selected.'],
  ]) {
    const id = store.createSDKSession(host, 'project', 'prompt');
    store.updateMemorySessionId(id, observer);
    store.storeObservation(observer, 'project', { type: 'discovery', title: host, subtitle: null, narrative: 'An observed fact', facts: [], concepts: ['how-it-works'], files_read: [], files_modified: [] }, 1, 0, epoch);
    writeFileSync(join(transcriptDir, host + '.jsonl'), JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: message }] } }) + '\n');
  }
  const observations = queryObservationsMulti(store, ['project'], config);
  const messages = getPriorSessionMessages(observations, config, 'current-host', cwd);
  const context = await generateContextWithStats({ projects: ['project'], cwd, session_id: 'current-host' });
  console.log(JSON.stringify({ messages, context }));
  store.close();
`;

describe('prior session transcript uses the observed host identity', () => {
  it('finds the prior Claude transcript and excludes the active host session', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prior-host-transcript-'));
    try {
      mkdirSync(join(dir, 'data'));
      writeFileSync(join(dir, 'data', 'settings.json'), JSON.stringify({ CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE: 'true' }));
      const run = Bun.spawnSync([process.execPath, '-e', fixture], {
        cwd: join(import.meta.dir, '../..'),
        env: { ...process.env, CLAUDE_MEM_DATA_DIR: join(dir, 'data'), CLAUDE_CONFIG_DIR: join(dir, 'config') },
        stdout: 'pipe', stderr: 'pipe',
      });
      if (run.exitCode !== 0) throw new Error(new TextDecoder().decode(run.stderr));
      expect(run.exitCode).toBe(0);
      const line = new TextDecoder().decode(run.stdout).trim().split('\n').at(-1)!;
      const result = JSON.parse(line);
      expect(result.messages).toEqual({ assistantMessage: 'A prior user-facing response.' });
      expect(result.context.text).toContain('A prior user-facing response.');
      expect(result.context.text).not.toContain('Current response should not be selected.');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
