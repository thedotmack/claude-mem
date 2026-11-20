import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const seedScript = `
  import { SessionStore } from './src/services/sqlite/SessionStore.ts';
  const store = new SessionStore(process.env.CLAUDE_MEM_DATA_DIR + '/claude-mem.db');
  const seed = (id, project, title, target, epoch = 1700000000000) => {
    const session = store.createSDKSession('content-' + id, project, 'prompt');
    store.ensureMemorySessionIdRegistered(session, id);
    store.storeObservation(id, project, {
      type: 'discovery', title, subtitle: null, facts: [], narrative: title,
      concepts: ['how-it-works'], files_read: [], files_modified: [],
    }, 1, 0, epoch);
    if (target) store.db.query('UPDATE observations SET merged_into_project = ? WHERE memory_session_id = ?').run(target, id);
  };
  seed('direct', 'folder', 'DIRECT_CONTEXT_RECORD', null);
  seed('merged', 'legacy', 'MERGED_CONTEXT_RECORD', 'acme/app');
  seed('unrelated', 'other', 'UNRELATED_CONTEXT_RECORD', null);
  seed('older', 'folder', 'OLDER_CONTEXT_RECORD', null, 1699999999000);
  store.appendWorkStateEntry({ project: 'folder', listName: 'next', fields: { step: 1 } });
  store.appendWorkStateEntry({ project: 'acme/app', listName: 'next', fields: { step: 2 } });
  store.appendWorkStateEntry({ project: 'legacy', listName: 'next', fields: { status: 'open' } });
  store.close();
`;

const readScript = `
  import { ModeManager } from './src/services/domain/ModeManager.ts';
  import { generateContextWithStats } from './src/services/context/ContextBuilder.ts';
  import { ContextReadWorkerClient } from './src/services/context/ContextReadWorkerClient.ts';
  import { loadContextConfig } from './src/services/context/ContextConfigLoader.ts';
  ModeManager.getInstance().loadMode('code');
  const reader = new ContextReadWorkerClient();
  const projects = ['folder', 'acme/app'];
  const input = { projects, cwd: '/context/acme/app', timePlaceholders: true, includePriorMessage: false };
  try {
    const keys = await reader.readKeys(projects);
    const state = await reader.workState(projects);
    const present = await reader.hasObservations(projects);
    const absent = await reader.hasObservations(['never-seen']);
    const mode = ModeManager.getInstance().getActiveMode();
    const discovery = mode.observation_types.find(type => type.id === 'discovery');
    if (!discovery) throw new Error('Fixture mode has no discovery type');
    discovery.emoji = 'ⓓ';
    const config = loadContextConfig();
    config.totalObservationCount = 2;
    const inline = await generateContextWithStats(input, false, { config });
    const isolated = await reader.render({ context: input, forHuman: false, mode, config });
    const dispatched = await generateContextWithStats(input, false, { execution: 'worker', reader, config });
    console.log(JSON.stringify({
      keys: keys.sort(), scopes: state.map(entry => entry.scope_project ?? entry.project),
      present, absent,
      sameStats: JSON.stringify(inline.stats) === JSON.stringify(isolated.stats), text: isolated.text, inlineText: inline.text, dispatchedText: dispatched.text,
    }));
  } finally {
    await reader.close();
  }
`;

describe('isolated context read results', () => {
  it('preserves aliases, merged records, work-state scopes and the inline context bytes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'claude-mem-reader-results-'));
    const env = {
      ...process.env,
      CLAUDE_MEM_DATA_DIR: directory,
      CLAUDE_CONFIG_DIR: directory,
      CLAUDE_MEM_MODES_DIR: join(process.cwd(), 'plugin/modes'),
      CLAUDE_MEM_TELEMETRY_ENABLED: 'false',
    };
    try {
      for (const script of [seedScript, readScript]) {
        const child = Bun.spawnSync([process.execPath, '-e', script], { cwd: process.cwd(), env });
        if (child.exitCode !== 0) throw new Error(new TextDecoder().decode(child.stderr));
        if (script !== readScript) continue;
        const result = JSON.parse(new TextDecoder().decode(child.stdout).trim().split('\n').at(-1)!);
        expect(result.keys).toEqual(['acme/app', 'folder', 'legacy']);
        expect(result.scopes).toEqual(['acme/app', 'acme/app', 'legacy']);
        expect(result.present).toBe(true);
        expect(result.absent).toBe(false);
        expect(result.text).toBe(result.inlineText);
        expect(result.dispatchedText).toBe(result.inlineText);
        expect(result.sameStats).toBe(true);
        expect(result.text).toContain('DIRECT_CONTEXT_RECORD');
        expect(result.text).toContain('MERGED_CONTEXT_RECORD');
        expect(result.text).toContain('ⓓ DIRECT_CONTEXT_RECORD');
        expect(result.text).not.toContain('OLDER_CONTEXT_RECORD');
        expect(result.text).not.toContain('UNRELATED_CONTEXT_RECORD');
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);
});
