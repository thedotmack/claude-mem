import { beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = String.raw`
  import express from 'express';
  import { SessionStore } from './src/services/sqlite/SessionStore.ts';
  import { SessionSearch } from './src/services/sqlite/SessionSearch.ts';
  import { SearchOrchestrator } from './src/services/worker/search/SearchOrchestrator.ts';
  import { CorpusBuilder } from './src/services/worker/knowledge/CorpusBuilder.ts';
  import { CorpusStore } from './src/services/worker/knowledge/CorpusStore.ts';
  import { CorpusRoutes } from './src/services/worker/http/routes/CorpusRoutes.ts';
  const store = new SessionStore(':memory:');
  for (const project of ['investigation', 'other']) {
    const sid = store.createSDKSession(project, project, 'Collect evidence.');
    store.ensureMemorySessionIdRegistered(sid, 'memory-' + project);
    for (const type of ['evidence', 'timeline-event', 'correction', 'bugfix']) {
      store.storeObservation('memory-' + project, project, { type, title: project + ' ' + type,
        subtitle: null, narrative: type, facts: [], concepts: [], files_read: [], files_modified: [] }, 1);
    }
  }
  const corpora = new CorpusStore();
  const builder = new CorpusBuilder(store, new SearchOrchestrator(new SessionSearch(store.db), store, null), corpora);
  const app = express(); app.use(express.json());
  new CorpusRoutes(corpora, builder, {}).setupRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.on('listening', resolve));
  try {
    const result = {};
    for (const [name, types] of [
      ['bundled-email', ['evidence', 'timeline-event']],
      ['custom-mode', 'correction'],
      ['json-encoded', '["evidence","correction"]'],
      ['coding-control', ['bugfix']],
    ]) {
      const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/corpus', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({name, project:'investigation', types}),
      });
      const body = await response.json();
      const saved = corpora.read(name);
      result[name] = {status:response.status, filter:body.filter,
        types:saved?.observations.map(row => row.type).sort(), projects:saved?.observations.map(row => row.project)};
    }
    console.log(JSON.stringify(result));
  } finally { await new Promise(resolve => server.close(resolve)); store.close(); }
`;

let results: Record<string, any>;
beforeAll(() => {
  const directory = mkdtempSync(join(tmpdir(), 'corpus-mode-types-'));
  try {
    const run = Bun.spawnSync([process.execPath, '-e', fixture], {
      cwd: join(import.meta.dir, '../../../..'),
      env: { ...process.env, CLAUDE_MEM_DATA_DIR: join(directory, 'data'), CLAUDE_CONFIG_DIR: join(directory, 'config') },
      stdout: 'pipe', stderr: 'pipe',
    });
    if (run.exitCode !== 0) throw new Error(new TextDecoder().decode(run.stderr));
    results = JSON.parse(new TextDecoder().decode(run.stdout).trim().split('\n').at(-1)!);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test.each([
  ['bundled-email', ['evidence', 'timeline-event']],
  ['custom-mode', ['correction']],
  ['json-encoded', ['evidence', 'correction']],
  ['coding-control', ['bugfix']],
] as const)('builds a scoped corpus through HTTP for %s observation types', (name, types) => {
  expect(results[name].status).toBe(200);
  expect(results[name].filter).toEqual({ project: 'investigation', types: [...types] });
  expect(results[name].types).toEqual([...types].sort());
  expect(results[name].projects).toEqual(types.map(() => 'investigation'));
});
