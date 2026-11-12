import { beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { projectReadKeys } from '../../src/services/sqlite/project-read-keys.js';

// Exercise the public merge operation and the same read paths a renamed
// environment uses. No Chroma process is needed for these SQLite reads.
const childScript = `
  import { writeFileSync } from 'node:fs';
  import { SessionStore } from './src/services/sqlite/SessionStore.ts';
  import { SessionSearch } from './src/services/sqlite/SessionSearch.ts';
  import { mergeProjectInto } from './src/services/infrastructure/ProjectMerge.ts';
  import { generateContext } from './src/services/context/ContextBuilder.ts';
  import { getObservationsByFilePath } from './src/services/sqlite/observations/get.ts';
  import { ModeManager } from './src/services/domain/ModeManager.ts';
  const dataDirectory = process.env.CLAUDE_MEM_DATA_DIR;
  writeFileSync(dataDirectory + '/settings.json', JSON.stringify({ CLAUDE_MEM_CHROMA_ENABLED: 'false' }));
  ModeManager.getInstance().loadMode('code');
  const store = new SessionStore(dataDirectory + '/claude-mem.db');
  const seed = (project, title, mergedInto = null) => {
    const id = store.createSDKSession('content-' + title, project, 'prompt');
    const memory = store.ensureMemorySessionIdRegistered(id, 'memory-' + title);
    store.storeObservation(memory, project, {
      type: 'discovery', title, subtitle: null, facts: [], narrative: title + ' narrative',
      concepts: ['how-it-works'], files_read: ['src/shared.ts'], files_modified: [],
    }, 1, 0, 1_700_000_000_000 + id);
    store.storeSummary(memory, project, {
      request: title.replaceAll('_', ' '), investigated: 'i', learned: 'l', completed: 'c', next_steps: 'n', notes: null,
    }, 1, 0, 1_700_000_000_000 + id);
    if (mergedInto) {
      store.db.query('UPDATE observations SET merged_into_project = ? WHERE memory_session_id = ?').run(mergedInto, memory);
      store.db.query('UPDATE session_summaries SET merged_into_project = ? WHERE memory_session_id = ?').run(mergedInto, memory);
    }
  };
  seed('repo/feature', 'CHAIN_FEATURE');
  seed('repo', 'CHAIN_REPO');
  seed('work', 'CHAIN_WORK');
  seed('portfolio', 'CHAIN_PORTFOLIO');
  seed('partial', 'PARTIAL_ADOPTED', 'repo');
  seed('partial', 'PARTIAL_PRIVATE');
  seed('partial-child', 'PARTIAL_DESCENDANT', 'partial');
  seed('unrelated', 'UNRELATED_RECORD');
  store.close();
  const merges = [];
  for (const [from, into] of [['repo/feature', 'repo'], ['repo', 'work'], ['work', 'portfolio']]) {
    merges.push(await mergeProjectInto({ from, into, dataDirectory }));
  }
  const reader = new SessionStore(dataDirectory + '/claude-mem.db');
  const keys = reader.getProjectReadKeys(['PORTFOLIO']);
  const search = new SessionSearch(reader.db);
  const observations = search.searchObservations(undefined, { projects: keys, limit: 100 }).map(row => row.title).sort();
  const summaries = search.searchSessions(undefined, { projects: keys, limit: 100 }).map(row => row.request).sort();
  const files = getObservationsByFilePath(reader.db, 'src/shared.ts', { projects: ['PORTFOLIO'], limit: 100 })
    .map(row => row.title).sort();
  const storedProjects = reader.db.query('SELECT project, merged_into_project FROM observations ORDER BY id').all();
  reader.close();
  const text = await generateContext({ projects: ['PORTFOLIO'] });
  console.log(JSON.stringify({ keys, observations, summaries, files, text, merges, storedProjects }));
`;

type ChainResult = {
  keys: string[];
  observations: string[];
  summaries: string[];
  files: string[];
  text: string;
  merges: Array<{ mergedObservations: number; mergedSummaries: number; chromaUpdates: number }>;
  storedProjects: Array<{ project: string; merged_into_project: string | null }>;
};

describe('recall after repeated whole-project merges', () => {
  let result: ChainResult;
  const expected = ['CHAIN_FEATURE', 'CHAIN_PORTFOLIO', 'CHAIN_REPO', 'CHAIN_WORK', 'PARTIAL_ADOPTED'];

  beforeAll(() => {
    const dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-merge-chain-'));
    try {
      const env = { ...process.env };
      // The fixture tests project recall with known counts and filters, not
      // the contributor's context preferences. Preserve test tripwires.
      for (const key of Object.keys(env)) if (key.startsWith('CLAUDE_MEM_CONTEXT_')) delete env[key];
      const child = Bun.spawnSync([process.execPath, '-e', childScript], {
        cwd: process.cwd(),
        env: {
          ...env,
          CLAUDE_MEM_DATA_DIR: dataDir,
          CLAUDE_CONFIG_DIR: dataDir,
          CLAUDE_MEM_CHROMA_ENABLED: 'false',
          CLAUDE_MEM_MODES_DIR: join(process.cwd(), 'plugin', 'modes'),
        },
      });
      if (child.exitCode !== 0) throw new Error(new TextDecoder().decode(child.stderr));
      result = JSON.parse(new TextDecoder().decode(child.stdout).trim());
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('keeps the original worktree in SessionStart context after three merges', () => {
    for (const title of expected) expect(result.text).toContain(title);
  });

  it('finds observations and summaries through the complete merge chain', () => {
    expect(result.observations).toEqual(expected);
    expect(result.summaries).toEqual(expected.map(title => title.replaceAll('_', ' ')));
    expect(result.keys).toContain('repo/feature');
  });

  it('keeps the original file evidence visible under the final environment', () => {
    expect(result.files).toEqual(expected);
  });

  it('does not promote partial adoptions or their descendants', () => {
    expect(result.keys).not.toContain('partial');
    expect(result.keys).not.toContain('partial-child');
    for (const hidden of ['PARTIAL_PRIVATE', 'PARTIAL_DESCENDANT', 'UNRELATED_RECORD']) {
      expect(result.text).not.toContain(hidden);
      expect(result.observations).not.toContain(hidden);
      expect(result.summaries).not.toContain(hidden.replaceAll('_', ' '));
      expect(result.files).not.toContain(hidden);
    }
  });

  it('does not flatten stored project identities or replay the merges', () => {
    expect(result.merges.map(merge => [merge.mergedObservations, merge.mergedSummaries, merge.chromaUpdates]))
      .toEqual([[1, 1, 0], [1, 1, 0], [1, 1, 0]]);
    expect(result.storedProjects.slice(0, 4)).toEqual([
      { project: 'repo/feature', merged_into_project: 'repo' },
      { project: 'repo', merged_into_project: 'work' },
      { project: 'work', merged_into_project: 'portfolio' },
      { project: 'portfolio', merged_into_project: null },
    ]);
  });
});

function seedAlias(store: SessionStore, id: string, project: string, mergedInto: string): void {
  const session = store.createSDKSession(id, project, 'prompt');
  const memory = store.ensureMemorySessionIdRegistered(session, 'memory-' + id);
  store.storeObservation(memory, project, {
    type: 'discovery', title: id, subtitle: null, facts: [], narrative: id,
    concepts: [], files_read: [], files_modified: [],
  }, 1);
  store.db.query('UPDATE observations SET merged_into_project = ? WHERE memory_session_id = ?').run(mergedInto, memory);
}

describe('merge-chain closure', () => {
  it('terminates on a reachable cycle without admitting a disconnected cycle', () => {
    const store = new SessionStore(':memory:');
    try {
      seedAlias(store, 'one', 'one', 'TWO');
      seedAlias(store, 'two', 'two', 'ONE');
      seedAlias(store, 'other-one', 'other-one', 'other-two');
      seedAlias(store, 'other-two', 'other-two', 'other-one');
      expect(projectReadKeys(store.db, ['one']).sort()).toEqual(['ONE', 'TWO', 'one', 'two']);
      expect(store.db.inTransaction).toBe(false);
    } finally { store.close(); }
  });

  it('promotes a whole source split across destinations discovered at different depths', () => {
    const store = new SessionStore(':memory:');
    try {
      seedAlias(store, 'left', 'left', 'middle');
      seedAlias(store, 'middle', 'middle', 'root');
      seedAlias(store, 'right', 'right', 'root');
      seedAlias(store, 'split-left', 'split', 'left');
      seedAlias(store, 'split-right', 'split', 'right');
      seedAlias(store, 'oldest', 'oldest', 'split');
      expect(projectReadKeys(store.db, ['root']).sort()).toEqual(['left', 'middle', 'oldest', 'right', 'root', 'split']);
    } finally { store.close(); }
  });
});
