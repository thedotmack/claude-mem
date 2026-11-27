import { afterEach, describe, expect, it, mock } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { importWorkspacePrompts, workspacePromptMatcher } from '../../../src/services/prompt-import/workspace-sync.js';
import { scanOwnerPrompts, scanWindowStart } from '../../../src/services/prompt-import/index.js';
import type { CloudSyncStatus } from '../../../src/services/sync/CloudSync.js';

const folders: string[] = [];
function temp() {
  const root = mkdtempSync(join(tmpdir(), 'cmem-workspace-import-'));
  folders.push(root);
  return root;
}
afterEach(() => { for (const root of folders.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('paid workspace prompt import', () => {
  it('matches the filesystem checkout, even from a subfolder, and keeps distinct copies and nested repositories out', () => {
    const dir = temp();
    const repo = join(dir, 'left', 'sample'), sibling = join(dir, 'right', 'sample');
    const nested = join(repo, 'nested'), inside = join(repo, 'src');
    for (const cwd of [nested, inside, sibling]) mkdirSync(cwd, { recursive: true });
    execFileSync('git', ['init', '-q', repo]);
    execFileSync('git', ['init', '-q', nested]);
    symlinkSync(sibling, join(repo, 'outside'), 'dir');
    const matches = workspacePromptMatcher(inside);
    expect(matches(repo)).toBe(true);
    expect(matches(inside)).toBe(true);
    for (const candidate of [nested, sibling, join(repo, 'outside'), null, 'sample', join(repo, 'missing')]) expect(matches(candidate)).toBe(false);
    expect(() => workspacePromptMatcher(homedir())).toThrow();
  });

  it('uses the genuine owner scan and reports row-level acknowledgements without returning text', async () => {
    const home = temp(), project = join(home, 'repo'), sibling = join(home, 'other');
    const history = join(home, '.claude', 'projects', 'test-project');
    for (const cwd of [project, sibling, history]) mkdirSync(cwd, { recursive: true });
    const now = Date.now(), first = scanWindowStart(now);
    const turns = [
      [first, project, 'Plan the next release'], [now, project, 'Write release notes'],
      [first - 1, project, 'Outside the window'], [now + 1, project, 'Future'],
      [now - 1000, sibling, 'Different repository'], [now - 2000, project, '<private>private prompt</private>'],
    ] as const;
    writeFileSync(join(history, 'sample.jsonl'), turns.map(([time, cwd, content], i) => JSON.stringify({
      type: 'user', origin: { kind: 'human' }, entrypoint: 'cli', uuid: 'prompt-' + i, sessionId: 'sample', timestamp: new Date(time).toISOString(), cwd, message: { role: 'user', content },
    })).join('\n'));
    const stored: string[] = [];
    const store = {
      importWorkspaceSyncPrompt: (p: { promptText: string }) => { stored.push(p.promptText); return stored.length; },
      workspacePromptSyncCounts: (ids: ReadonlySet<number>) => ({ confirmed: ids.size - 1, queued: 1, failed: 0 }),
    };
    const cloud = {
      workspaceSyncAccount: () => 'account-a',
      statusWithHubProbe: async () => ({ hub: { reachable: true }, authError: null } as CloudSyncStatus),
      flush: mock(async () => {}),
    };
    const report = await importWorkspacePrompts(project, 'account-a', store, cloud,
      opts => scanOwnerPrompts({ ...opts, agents: ['claude-code'], excludedProjects: '', homeDirectory: home }), now);
    expect(stored).toEqual(['Plan the next release', 'Write release notes']);
    expect(report).toEqual({ eligible: 2, queued: 1, confirmed: 1, failed: 0, detectedAgents: ['Claude Code'], skippedSources: 0 });
    expect(cloud.flush).toHaveBeenCalledTimes(1);
    await expect(importWorkspacePrompts(project, 'wrong', store, cloud)).rejects.toThrow('different account');
    expect(stored).toHaveLength(2);
  });
});
