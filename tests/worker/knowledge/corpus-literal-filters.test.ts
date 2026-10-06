import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = String.raw`
  import { SessionStore } from './src/services/sqlite/SessionStore.ts';
  import { SessionSearch } from './src/services/sqlite/SessionSearch.ts';
  import { SearchOrchestrator } from './src/services/worker/search/SearchOrchestrator.ts';
  import { CorpusBuilder } from './src/services/worker/knowledge/CorpusBuilder.ts';
  const store = new SessionStore(':memory:');
  const sid = store.createSDKSession('host', 'literal-project', 'ask');
  store.ensureMemorySessionIdRegistered(sid, 'memory');
  const make = (title, concepts, files_read) => store.storeObservation('memory', 'literal-project', {
    type: 'discovery', title, subtitle: null, narrative: title, facts: [], concepts, files_read, files_modified: []
  }, 1);
  make('Wanted literal', ['tradeoff, measured'], ['src/report,final.ts']);
  make('Unrelated split match', ['tradeoff'], ['src/report.ts']);
  const search = new SessionSearch(store.db);
  const builder = new CorpusBuilder(store, new SearchOrchestrator(search, store, null), {});
  try {
    const file = await builder.build('literal-file', '', { project: 'literal-project', files: ['src/report,final.ts'] }, { writeFile: false });
    const concept = await builder.build('literal-concept', '', { project: 'literal-project', concepts: ['tradeoff, measured'] }, { writeFile: false });
    const alternatives = await builder.build('alternatives', '', { project: 'literal-project', files: ['src/report,final.ts', 'src/report.ts'] }, { writeFile: false });
    console.log(JSON.stringify({ file: file.observations.map(o => o.title), concept: concept.observations.map(o => o.title), alternatives: alternatives.observations.map(o => o.title) }));
  } finally { store.close(); }
`;

describe('corpus literal array filters', () => {
  it('preserves commas inside filenames and concepts through production search', () => {
    const dir = mkdtempSync(join(tmpdir(), 'corpus-literals-'));
    try {
      const run = Bun.spawnSync([process.execPath, '-e', fixture], {
        cwd: join(import.meta.dir, '../../..'), env: { ...process.env, CLAUDE_MEM_DATA_DIR: join(dir, 'data'), CLAUDE_CONFIG_DIR: join(dir, 'config') }, stdout: 'pipe', stderr: 'pipe',
      });
      if (run.exitCode !== 0) throw new Error(new TextDecoder().decode(run.stderr));
      const result = JSON.parse(new TextDecoder().decode(run.stdout).trim().split('\n').at(-1)!);
      expect(result.file).toEqual(['Wanted literal']);
      expect(result.concept).toEqual(['Wanted literal']);
      expect(result.alternatives.sort()).toEqual(['Unrelated split match', 'Wanted literal']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
