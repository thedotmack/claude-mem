/**
 * Tests for git ancestry resolution utility
 *
 * Validates getCurrentHead, resolveAncestorCommits, and resolveVisibleCommitShas
 * using this repo's actual git history for integration-level correctness.
 */
import { describe, it, expect } from 'bun:test';
import { execSync } from 'child_process';
import {
  getCurrentHead,
  resolveAncestorCommits,
  resolveVisibleCommitShas
} from '../src/services/integrations/git-ancestry.js';

// Resolve repo root dynamically so tests work from any cwd
const REPO_ROOT = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();

describe('getCurrentHead', () => {
  it('should return a 40-character hex SHA when run inside a git repo', async () => {
    const head = await getCurrentHead(REPO_ROOT);
    expect(head).not.toBeNull();
    expect(head!.length).toBe(40);
    expect(/^[0-9a-f]{40}$/.test(head!)).toBe(true);
  });

  it('should return null for a non-git directory', async () => {
    const head = await getCurrentHead('/tmp');
    expect(head).toBeNull();
  });
});

describe('resolveAncestorCommits', () => {
  it('should consider HEAD an ancestor of itself', async () => {
    const head = await getCurrentHead(REPO_ROOT);
    expect(head).not.toBeNull();

    const ancestors = await resolveAncestorCommits(head!, [head!], REPO_ROOT);
    expect(ancestors).toContain(head!);
  });

  it('should identify an old commit as an ancestor of HEAD', async () => {
    const head = await getCurrentHead(REPO_ROOT);
    expect(head).not.toBeNull();

    // Use the repo's very first commit
    const oldestCommit = execSync('git log --format="%H" | tail -1', {
      cwd: REPO_ROOT,
      encoding: 'utf8'
    }).trim();

    const ancestors = await resolveAncestorCommits(head!, [oldestCommit], REPO_ROOT);
    expect(ancestors).toContain(oldestCommit);
  });

  it('should gracefully exclude a fabricated non-existent SHA', async () => {
    const head = await getCurrentHead(REPO_ROOT);
    expect(head).not.toBeNull();

    const fakeSha = '0000000000000000000000000000000000000000';
    const ancestors = await resolveAncestorCommits(head!, [fakeSha], REPO_ROOT);
    expect(ancestors).not.toContain(fakeSha);
    expect(ancestors).toHaveLength(0);
  });

  it('should handle mixed valid and invalid SHAs', async () => {
    const head = await getCurrentHead(REPO_ROOT);
    expect(head).not.toBeNull();

    const fakeSha = '0000000000000000000000000000000000000000';
    const candidates = [head!, fakeSha];

    const ancestors = await resolveAncestorCommits(head!, candidates, REPO_ROOT);
    expect(ancestors).toContain(head!);
    expect(ancestors).not.toContain(fakeSha);
    expect(ancestors).toHaveLength(1);
  });

  it('should return empty array for empty candidates', async () => {
    const head = await getCurrentHead(REPO_ROOT);
    expect(head).not.toBeNull();

    const ancestors = await resolveAncestorCommits(head!, [], REPO_ROOT);
    expect(ancestors).toHaveLength(0);
  });
});

describe('resolveVisibleCommitShas', () => {
  it('should return null for a non-git directory', async () => {
    const result = await resolveVisibleCommitShas(['abc'], '/tmp');
    expect(result).toBeNull();
  });

  it('should return empty array for empty candidates in a git repo', async () => {
    const result = await resolveVisibleCommitShas([], REPO_ROOT);
    expect(result).toEqual([]);
  });

  it('should filter candidates to only ancestors of HEAD', async () => {
    const head = await getCurrentHead(REPO_ROOT);
    expect(head).not.toBeNull();

    const fakeSha = '0000000000000000000000000000000000000000';
    const result = await resolveVisibleCommitShas([head!, fakeSha], REPO_ROOT);

    expect(result).not.toBeNull();
    expect(result).toContain(head!);
    expect(result).not.toContain(fakeSha);
  });
});
