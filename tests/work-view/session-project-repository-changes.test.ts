import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { folderNeedsProject, NO_PROJECT, projectFromToolPaths, repoRootOf, withDerivedProjects } from '../../src/services/work-view/session-project.mjs';
import { getProjectContext } from '../../src/utils/project-name.js';

let root: string;
let previousSource: string | undefined;
let previousEnvironments: string | undefined;
let nextSessionId = 700_000;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'project-repository-change-'));
  previousSource = process.env.CLAUDE_MEM_PROJECT_NAME_SOURCE;
  previousEnvironments = process.env.CLAUDE_MEM_PROJECT_ENVIRONMENTS;
  process.env.CLAUDE_MEM_PROJECT_NAME_SOURCE = 'path';
  process.env.CLAUDE_MEM_PROJECT_ENVIRONMENTS = '[]';
});
afterEach(() => {
  if (previousSource === undefined) delete process.env.CLAUDE_MEM_PROJECT_NAME_SOURCE;
  else process.env.CLAUDE_MEM_PROJECT_NAME_SOURCE = previousSource;
  if (previousEnvironments === undefined) delete process.env.CLAUDE_MEM_PROJECT_ENVIRONMENTS;
  else process.env.CLAUDE_MEM_PROJECT_ENVIRONMENTS = previousEnvironments;
  rmSync(root, { recursive: true, force: true });
});

function directory(name: string) {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  return path;
}
function init(path: string) { execFileSync('git', ['-C', path, 'init', '-q']); }
const input = (path: string) => JSON.stringify({ file_path: join(path, 'README.md') });
// A runner may put TMPDIR inside its own checkout. Account for that real
// ancestor rather than assuming every temporary folder is outside Git.
const enclosingRoot = () => repoRootOf(root);
const enclosingProject = () => {
  const parent = enclosingRoot();
  return parent ? getProjectContext(parent).primary : NO_PROJECT;
};

describe('project repository discovery across reads', () => {
  it('finds a repository initialized after an earlier lookup', () => {
    const repo = directory('created-repo');
    const source = directory('created-repo/src');
    expect(repoRootOf(source)).toBe(enclosingRoot());
    init(repo);
    expect(repoRootOf(source)).toBe(repo);
  });

  it('finds a nearer nested repository added below a previously cached parent', () => {
    const parent = directory('parent');
    const nested = directory('parent/nested');
    const source = directory('parent/nested/src');
    init(parent);
    expect(repoRootOf(source)).toBe(parent);
    init(nested);
    expect(repoRootOf(source)).toBe(nested);
  });

  for (const keepParent of [false, true]) {
    it(`forgets removed repository metadata${keepParent ? ' and finds the remaining parent' : ''}`, () => {
      const parent = directory('parent');
      const nested = directory('parent/nested');
      const source = directory('parent/nested/src');
      const outside = enclosingRoot();
      if (keepParent) init(parent);
      init(nested);
      expect(repoRootOf(source)).toBe(nested);
      rmSync(join(nested, '.git'), { recursive: true });
      expect(repoRootOf(source)).toBe(keepParent ? parent : outside);
    });
  }

  it('keeps an existing repository folder assigned to its stored project', () => {
    const repo = directory('new-checkout');
    init(repo);
    expect(folderNeedsProject(repo, 'new-checkout')).toBe(false);
  });

  it('derives a newly initialized repository from the same captured paths on a later read', () => {
    const repo = directory('release');
    const calls = [input(repo), input(repo)];
    expect(projectFromToolPaths(calls)).toBe(enclosingProject());
    init(repo);
    expect(projectFromToolPaths(calls)).toBe('release');
  });

  it('derives a newly nested repository instead of retaining its parent project', () => {
    const parent = directory('parent');
    const nested = directory('parent/product');
    init(parent);
    expect(projectFromToolPaths([input(nested)])).toBe('parent');
    init(nested);
    expect(projectFromToolPaths([input(nested)])).toBe('product');
  });

  it('refreshes a scratch session after its next tool call touches the newly initialized repository', () => {
    const scratch = directory('scratch');
    const repo = directory('product');
    const db = new Database(':memory:');
    const sessionId = nextSessionId++;
    try {
      db.exec(`CREATE TABLE sdk_sessions(id INTEGER PRIMARY KEY, project TEXT, cwd TEXT);
        CREATE TABLE tool_uses(id INTEGER PRIMARY KEY, session_db_id INTEGER, tool_input TEXT, cwd TEXT);`);
      db.prepare('INSERT INTO sdk_sessions VALUES (?, ?, ?)').run(sessionId, 'scratch', scratch);
      // Deleted temporary working folders are still eligible for derivation,
      // including when the test runner's temp parent is a repository itself.
      rmSync(scratch, { recursive: true });
      const call = db.prepare('INSERT INTO tool_uses(session_db_id, tool_input, cwd) VALUES (?, ?, ?)');
      call.run(sessionId, input(repo), null);
      const sessions = [{ id: sessionId, project: 'scratch' }];
      expect(withDerivedProjects(db, sessions)[0]).toMatchObject({ project: enclosingProject(), storedProject: 'scratch' });
      init(repo);
      // The existing derived-project cache still waits for another tool call.
      expect(withDerivedProjects(db, sessions)[0]).toMatchObject({ project: enclosingProject(), storedProject: 'scratch' });
      call.run(sessionId, input(repo), null);
      expect(withDerivedProjects(db, sessions)[0]).toMatchObject({ project: 'product', storedProject: 'scratch' });
      expect(db.query('SELECT project FROM sdk_sessions WHERE id = ?').get(sessionId)).toEqual({ project: 'scratch' });
    } finally { db.close(); }
  });

  it('keeps sibling paths outside the newly discovered repository', () => {
    const repo = directory('repo');
    const sibling = directory('repo-copy');
    init(repo);
    expect(projectFromToolPaths([input(repo)])).toBe('repo');
    expect(repoRootOf(sibling)).toBe(enclosingRoot());
    expect(projectFromToolPaths([input(sibling)])).toBe(enclosingProject());
  });

  it('continues to recognize a worktree-style git file and nearest repository', () => {
    const repo = directory('worktree');
    const source = directory('worktree/src');
    writeFileSync(join(repo, '.git'), 'gitdir: ../parent/.git/worktrees/worktree\n');
    expect(repoRootOf(source)).toBe(repo);
    expect(folderNeedsProject(repo, basename(repo))).toBe(false);
  });
});
