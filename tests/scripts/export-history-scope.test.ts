import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = String.raw`
  import express from 'express';
  import { readFileSync, writeFileSync } from 'node:fs';
  import { join } from 'node:path';
  import { SessionStore } from './src/services/sqlite/SessionStore.ts';
  import { SessionSearch } from './src/services/sqlite/SessionSearch.ts';
  import { SearchManager } from './src/services/worker/SearchManager.ts';
  import { FormattingService } from './src/services/worker/FormattingService.ts';
  import { TimelineService } from './src/services/worker/TimelineService.ts';
  import { SearchRoutes } from './src/services/worker/http/routes/SearchRoutes.ts';
  import { DataRoutes } from './src/services/worker/http/routes/DataRoutes.ts';
  import { exportMemories } from './scripts/export-memories.ts';

  const source = new SessionStore(':memory:');
  const now = Date.now();
  const old = now - 180 * 86_400_000;
  for (const project of ['selected', 'other']) {
    const session = source.createSDKSession(project, project, 'opening');
    source.ensureMemorySessionIdRegistered(session, project + '-memory');
    source.saveUserPrompt(project, 1, project + ' prompt', session);
    source.storeSummary(project + '-memory', project, {
      request: project + ' request', investigated: '', learned: '',
      completed: '', next_steps: '', notes: null,
    }, 1, 0, old);
  }
  const ids = [];
  for (const [project, title, epoch] of [
    ['selected', 'Archived architecture', old],
    ['selected', 'Current design', now],
    ['selected', 'Epoch boundary', 0],
    ['other', 'Other project', now],
  ]) {
    ids.push(source.storeObservation(project + '-memory', project, {
      type: 'discovery', title, subtitle: null, narrative: title,
      facts: [], concepts: [], files_read: [], files_modified: [],
    }, 1, 0, epoch).id);
  }
  const rows = source.getObservationsByIds(ids, { orderBy: 'relevance' });
  // Only the external semantic transport is faked. Its candidates still pass
  // through production recency filtering, SQLite hydration and project scope.
  const chroma = process.env.EXPORT_CASE === 'semantic' ? {
    queryChroma: async () => ({
      ids, distances: ids.map(() => 0.1),
      metadatas: rows.map(row => ({ sqlite_id: row.id, doc_type: 'observation',
        project: row.project, created_at_epoch: row.created_at_epoch })),
    }),
  } : null;
  const manager = new SearchManager(new SessionSearch(source.db), source, chroma,
    new FormattingService(), new TimelineService());
  const app = express(); app.use(express.json());
  new SearchRoutes(manager).setupRoutes(app);
  new DataRoutes({}, { getSessionStore: () => source, getChromaSync: () => null },
    {}, {}, {}, Date.now()).setupRoutes(app);
  const listener = app.listen(0, '127.0.0.1');
  await new Promise(resolve => listener.once('listening', resolve));
  const base = 'http://127.0.0.1:' + listener.address().port;
  writeFileSync(join(process.env.CLAUDE_MEM_DATA_DIR, 'settings.json'),
    JSON.stringify({ CLAUDE_MEM_WORKER_PORT: String(listener.address().port) }));
  try {
    let normalTitles;
    const semantic = process.env.EXPORT_CASE === 'semantic';
    if (semantic) {
      const response = await fetch(base + '/api/search?query=meaning&project=selected&format=json');
      normalTitles = (await response.json()).observations.map(row => row.title).sort();
    }
    const output = join(process.env.CLAUDE_MEM_DATA_DIR, 'export.json');
    await exportMemories(semantic ? 'meaning' : '', output,
      process.env.EXPORT_CASE === 'all' ? undefined : 'selected');
    const data = JSON.parse(readFileSync(output, 'utf8'));
    console.log(JSON.stringify({
      titles: data.observations.map(row => row.title).sort(),
      parents: data.sessions.map(row => row.project).sort(),
      summaries: data.totalSummaries, prompts: data.totalPrompts, normalTitles,
    }));
  } finally {
    await new Promise(resolve => listener.close(resolve));
    source.close();
  }
`;

for (const scenario of ['all', 'project', 'semantic']) {
  it(`exports the complete ${scenario} history through the worker search route`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-mem-export-history-'));
    try {
      const child = Bun.spawnSync([process.execPath, '-e', fixture], {
        cwd: join(import.meta.dir, '../..'),
        env: { ...process.env, CLAUDE_MEM_DATA_DIR: dir, CLAUDE_CONFIG_DIR: join(dir, 'config'),
          CLAUDE_MEM_EXPORT_MEMORIES_NO_MAIN: '1', EXPORT_CASE: scenario },
        stdout: 'pipe', stderr: 'pipe',
      });
      if (child.exitCode !== 0) throw new Error(new TextDecoder().decode(child.stderr));
      const actual = JSON.parse(new TextDecoder().decode(child.stdout).trim().split('\n').at(-1)!);
      expect(actual.titles).toEqual(scenario === 'all'
        ? ['Archived architecture', 'Current design', 'Epoch boundary', 'Other project']
        : ['Archived architecture', 'Current design', 'Epoch boundary']);
      expect(actual.parents).toEqual(scenario === 'all' ? ['other', 'selected'] : ['selected']);
      expect(actual.summaries).toBe(scenario === 'all' ? 2 : scenario === 'project' ? 1 : 0);
      expect(actual.prompts).toBe(scenario === 'all' ? 2 : scenario === 'project' ? 1 : 0);
      if (scenario === 'semantic') expect(actual.normalTitles).toEqual(['Current design']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
