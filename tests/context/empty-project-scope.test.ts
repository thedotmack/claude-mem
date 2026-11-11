import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = String.raw`
  import express from 'express';
  import { SessionStore } from './src/services/sqlite/SessionStore.ts';
  import { DB_PATH } from './src/shared/paths.ts';
  import { projectReadKeys } from './src/services/sqlite/project-read-keys.ts';
  import { queryObservationsMulti, queryObservationsNewest } from './src/services/context/ObservationCompiler.ts';
  import { SearchRoutes } from './src/services/worker/http/routes/SearchRoutes.ts';
  import { ModeManager } from './src/services/domain/ModeManager.ts';
  ModeManager.getInstance().loadMode('code');
  const store = new SessionStore(DB_PATH);
  for (const [project, title, at] of [['app', 'APP_CONTEXT_RECORD', 1000], ['other', 'OTHER_CONTEXT_RECORD', 2000]]) {
    const session = store.createSDKSession(project, project, 'prompt');
    store.ensureMemorySessionIdRegistered(session, 'memory-' + project);
    store.storeObservation('memory-' + project, project, {
      type: 'discovery', title, subtitle: null, facts: [], narrative: title,
      concepts: ['how-it-works'], files_read: [], files_modified: [],
    }, 1, 0, at);
  }
  const config = { totalObservationCount: 10, fullObservationCount: 0, sessionCount: 0,
    showReadTokens: false, showWorkTokens: false, observationTypes: new Set(['discovery']),
    observationConcepts: new Set(['how-it-works']), fullObservationField: 'narrative',
    showLastSummary: false, showLastMessage: false, mainAgentOnly: false };
  const titles = rows => rows.map(row => row.title);
  const result = {
    empty: titles(queryObservationsMulti(store, [], config)),
    blank: titles(queryObservationsMulti(store, projectReadKeys(store.db, [' ', '\t']), config)),
    explicitEmpty: titles(queryObservationsNewest(store, config, { limit: 10, projects: [] })),
    house: titles(queryObservationsNewest(store, config, { limit: 10 })),
    scoped: titles(queryObservationsNewest(store, config, { limit: 10, projects: [' ', 'app'] })),
  };
  store.close();
  const app = express();
  new SearchRoutes({}).setupRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    for (const [name, project] of [['previewBlank', ' '], ['previewApp', 'app']]) {
      const response = await fetch(base + '/api/context/preview?project=' + encodeURIComponent(project));
      result[name] = { status: response.status, body: await response.text() };
    }
    console.log(JSON.stringify(result));
  } finally { await new Promise(resolve => server.close(resolve)); }
`;

describe('explicitly empty context project scope', () => {
  it('keeps empty filters empty while preserving the unscoped house feed and a named project', () => {
    const directory = mkdtempSync(join(tmpdir(), 'context-empty-scope-'));
    try {
      const run = Bun.spawnSync([process.execPath, '-e', fixture], {
        cwd: join(import.meta.dir, '../..'),
        env: { ...process.env, CLAUDE_MEM_DATA_DIR: join(directory, 'data'),
          CLAUDE_CONFIG_DIR: join(directory, 'config'), CLAUDE_MEM_MODES_DIR: join(import.meta.dir, '../../plugin/modes'),
          CLAUDE_MEM_RUNTIME: 'worker', DO_NOT_TRACK: '1' },
        stdout: 'pipe', stderr: 'pipe',
      });
      if (run.exitCode !== 0) throw new Error(new TextDecoder().decode(run.stderr));
      const result = JSON.parse(new TextDecoder().decode(run.stdout).trim().split('\n').at(-1)!);
      expect(result.house).toEqual(['OTHER_CONTEXT_RECORD', 'APP_CONTEXT_RECORD']);
      expect(result.scoped).toEqual(['APP_CONTEXT_RECORD']);
      if (result.previewApp.status !== 200) throw new Error(result.previewApp.body);
      expect(result.previewApp.status).toBe(200);
      expect(result.previewApp.body).toContain('APP_CONTEXT_RECORD');
      expect(result.previewApp.body).not.toContain('OTHER_CONTEXT_RECORD');
      expect(result.previewBlank.status).toBe(200);
      expect(result.previewBlank.body).not.toContain('OTHER_CONTEXT_RECORD');
      expect(result.previewBlank.body).not.toContain('APP_CONTEXT_RECORD');
      expect(result.empty).toEqual([]);
      expect(result.blank).toEqual([]);
      expect(result.explicitEmpty).toEqual([]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
