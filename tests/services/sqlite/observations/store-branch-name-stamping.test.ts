import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { execSync } from 'child_process';
import { mkdtempSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';

describe('observation writer: branch_name stamping', () => {
  let store: SessionStore;
  let testDbPath: string;
  let repoPath: string;

  beforeEach(() => {
    testDbPath = `/tmp/test-branch-name-${crypto.randomUUID()}.db`;
    store = new SessionStore(testDbPath);

    // Create a git repo with two branches
    repoPath = mkdtempSync(join(tmpdir(), 'obs-repo-'));
    try {
      execSync(`git -C "${repoPath}" init -b main`);
      writeFileSync(join(repoPath, 'f'), 'x');
      execSync(`git -C "${repoPath}" add . && git -C "${repoPath}" commit -m init`);
      execSync(`git -C "${repoPath}" checkout -b feature/foo`);
    } catch (e) {
      console.error('Failed to setup test repo:', e);
      throw e;
    }
  });

  afterEach(() => {
    store.close();
    try {
      unlinkSync(testDbPath);
    } catch (e) {}
  });

  function createObservationInput(overrides: any = {}): any {
    return {
      type: 'discovery',
      title: 'Test Observation',
      subtitle: 'Subtitle',
      facts: ['fact1'],
      narrative: 'Narrative body',
      concepts: ['concept1'],
      files_read: ['/path/to/file1.ts'],
      files_modified: [],
      ...overrides,
    };
  }

  function createSessionWithMemoryId(
    contentSessionId: string,
    memorySessionId: string,
    project = 'test-project'
  ): string {
    const sessionId = store.createSDKSession(contentSessionId, project, 'initial prompt');
    store.updateMemorySessionId(sessionId, memorySessionId);
    return memorySessionId;
  }

  it('stamps the current git branch onto the new observation', () => {
    const memorySessionId = createSessionWithMemoryId('content-branch-1', 'mem-branch-1', repoPath);

    const result = store.storeObservation(memorySessionId, repoPath, createObservationInput({
      title: 'Test observation',
      narrative: 'This is a test',
    }));

    // Verify observation has branch_name = 'feature/foo'
    const obs = store['db']
      .prepare('SELECT * FROM observations WHERE id = ?')
      .get(result.id) as { branch_name: string | null } | null;

    expect(obs).not.toBeNull();
    expect(obs?.branch_name).toBe('feature/foo');
  });

  it('stamps different branches when observations are written from different branches', () => {
    const memorySessionId = createSessionWithMemoryId('content-dedup-1', 'mem-dedup-1', repoPath);

    // Write from feature/foo
    const result1 = store.storeObservation(
      memorySessionId,
      repoPath,
      createObservationInput({
        title: 'Obs 1',
        narrative: 'From foo',
      })
    );

    // Switch to main
    execSync(`git -C "${repoPath}" checkout main`);

    // Write from main
    const result2 = store.storeObservation(
      memorySessionId,
      repoPath,
      createObservationInput({
        title: 'Obs 2',
        narrative: 'From main',
      })
    );

    const obs1 = store['db']
      .prepare('SELECT * FROM observations WHERE id = ?')
      .get(result1.id) as { branch_name: string | null };
    const obs2 = store['db']
      .prepare('SELECT * FROM observations WHERE id = ?')
      .get(result2.id) as { branch_name: string | null };

    expect(obs1.branch_name).toBe('feature/foo');
    expect(obs2.branch_name).toBe('main');
  });

  it('handles detached HEAD state (stamps NULL for branch_name)', () => {
    const memorySessionId = createSessionWithMemoryId('content-detached-1', 'mem-detached-1', repoPath);

    // Get a commit SHA and detach HEAD
    const commitSha = execSync(`git -C "${repoPath}" rev-parse HEAD`).toString().trim();
    execSync(`git -C "${repoPath}" checkout ${commitSha}`);

    const result = store.storeObservation(
      memorySessionId,
      repoPath,
      createObservationInput({
        title: 'Detached HEAD obs',
        narrative: 'Written while detached',
      })
    );

    const obs = store['db']
      .prepare('SELECT * FROM observations WHERE id = ?')
      .get(result.id) as { branch_name: string | null };

    // Detached HEAD should result in NULL branch_name
    expect(obs.branch_name).toBeNull();
  });

  it('handles non-git projects (stamps NULL for branch_name)', () => {
    // Use a non-git directory
    const nonGitPath = mkdtempSync(join(tmpdir(), 'non-git-'));
    const memorySessionId = createSessionWithMemoryId('content-nongit-1', 'mem-nongit-1', nonGitPath);

    const result = store.storeObservation(
      memorySessionId,
      nonGitPath,
      createObservationInput({
        title: 'Non-git obs',
        narrative: 'Written in non-git project',
      })
    );

    const obs = store['db']
      .prepare('SELECT * FROM observations WHERE id = ?')
      .get(result.id) as { branch_name: string | null };

    expect(obs.branch_name).toBeNull();
  });
});

