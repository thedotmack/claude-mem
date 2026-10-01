// Gate P2-4: `project merge repo work` stamps repo's rows merged_into_project=
// 'work', but rows that were already folded into `repo` (an adopted worktree,
// say) stay merged into `repo`. SessionStart for `work` reads one hop of that
// chain, so the merge brings the repository's adopted memory along.
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const repoRoot = process.cwd();
const childScript = `
  import { SessionStore } from './src/services/sqlite/SessionStore.ts';
  import { generateContext } from './src/services/context/ContextBuilder.ts';
  import { ModeManager } from './src/services/domain/ModeManager.ts';
  ModeManager.getInstance().loadMode('code');
  const store = new SessionStore(process.env.CLAUDE_MEM_DATA_DIR + '/claude-mem.db');
  const seed = (memoryId, project, title, epoch, mergedInto) => {
    const sessionDbId = store.createSDKSession('content-' + memoryId, project, 'prompt');
    store.ensureMemorySessionIdRegistered(sessionDbId, memoryId);
    store.storeObservation(memoryId, project, {
      type: 'discovery', title, subtitle: null, facts: [], narrative: title + ' narrative',
      concepts: ['how-it-works'], files_read: [], files_modified: [],
    }, 1, 0, epoch);
    if (mergedInto) {
      store.db.prepare('UPDATE observations SET merged_into_project = ? WHERE title = ?').run(mergedInto, title);
    }
  };
  seed('m-work', 'work', 'WORK_NATIVE_RECORD', 1_700_000_000_000, null);
  seed('m-repo', 'repo', 'REPO_FOLDED_RECORD', 1_700_000_000_001, 'work');
  seed('m-wt', 'repo/feature', 'WORKTREE_ONE_HOP_RECORD', 1_700_000_000_002, 'repo');
  seed('m-other', 'other', 'UNRELATED_RECORD', 1_700_000_000_003, null);
  store.close();
  console.log(JSON.stringify({ text: await generateContext({ projects: ['work'] }) }));
`;

describe('SessionStart reads one hop of a merge chain (gate P2-4)', () => {
  it('includes rows merged into a project that was itself merged into this one', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-merge-hop-'));
    try {
      const result = Bun.spawnSync(['bun', '-e', childScript], {
        cwd: repoRoot,
        env: {
          ...process.env,
          CLAUDE_MEM_DATA_DIR: dataDir,
          CLAUDE_CONFIG_DIR: dataDir,
          CLAUDE_MEM_MODES_DIR: join(repoRoot, 'plugin', 'modes'),
        },
      });
      if (result.exitCode !== 0) {
        throw new Error(new TextDecoder().decode(result.stderr));
      }
      const { text } = JSON.parse(new TextDecoder().decode(result.stdout).trim()) as { text: string };

      expect(text).toContain('WORK_NATIVE_RECORD');
      expect(text).toContain('REPO_FOLDED_RECORD');
      expect(text).toContain('WORKTREE_ONE_HOP_RECORD');
      expect(text).not.toContain('UNRELATED_RECORD');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
