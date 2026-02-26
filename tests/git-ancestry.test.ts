/**
 * Tests for git ancestry resolution utility
 *
 * Validates getCurrentHead, resolveAncestorCommits, and resolveVisibleCommitShas
 * using this repo's actual git history for integration-level correctness.
 * Also validates edge cases: shallow clones, non-existent SHAs, non-git dirs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
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

  it('should gracefully handle partially-valid SHAs (simulates shallow clone truncation)', async () => {
    const head = await getCurrentHead(REPO_ROOT);
    expect(head).not.toBeNull();

    // Truncated SHAs (too short to be valid git objects) should be excluded, not throw
    const truncatedSha = 'abcdef1234567890';
    const ancestors = await resolveAncestorCommits(head!, [truncatedSha], REPO_ROOT);
    expect(ancestors).not.toContain(truncatedSha);
    expect(ancestors).toHaveLength(0);
  });

  it('should work correctly in a non-git directory (returns empty)', async () => {
    // When called with a non-git cwd, execSync will fail for each candidate
    const ancestors = await resolveAncestorCommits(
      '0000000000000000000000000000000000000000',
      ['0000000000000000000000000000000000000001'],
      '/tmp'
    );
    expect(ancestors).toHaveLength(0);
  });
});

describe('resolveAncestorCommits - shallow clone handling', () => {
  let originDir: string;
  let shallowDir: string;
  let oldestCommit: string;
  let createdShallowClone = false;

  beforeAll(() => {
    try {
      // Create a small origin repo with multiple commits
      originDir = mkdtempSync(join(tmpdir(), 'git-origin-test-'));
      execSync('git init', { cwd: originDir, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: originDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: originDir, stdio: 'pipe' });
      execSync('echo "v1" > file.txt', { cwd: originDir, stdio: 'pipe' });
      execSync('git add .', { cwd: originDir, stdio: 'pipe' });
      execSync('git commit -m "first"', { cwd: originDir, stdio: 'pipe' });
      oldestCommit = execSync('git rev-parse HEAD', { cwd: originDir, encoding: 'utf8' }).trim();
      execSync('echo "v2" >> file.txt', { cwd: originDir, stdio: 'pipe' });
      execSync('git add .', { cwd: originDir, stdio: 'pipe' });
      execSync('git commit -m "second"', { cwd: originDir, stdio: 'pipe' });
      execSync('echo "v3" >> file.txt', { cwd: originDir, stdio: 'pipe' });
      execSync('git add .', { cwd: originDir, stdio: 'pipe' });
      execSync('git commit -m "third"', { cwd: originDir, stdio: 'pipe' });

      // Create a shallow clone with depth=1
      shallowDir = mkdtempSync(join(tmpdir(), 'git-shallow-test-'));
      execSync(`git clone --depth 1 "file://${originDir}" "${shallowDir}"`, { stdio: 'pipe' });
      createdShallowClone = true;
    } catch {
      createdShallowClone = false;
    }
  });

  afterAll(() => {
    if (originDir) rmSync(originDir, { recursive: true, force: true });
    if (shallowDir) rmSync(shallowDir, { recursive: true, force: true });
  });

  it('should gracefully handle ancestry checks in a shallow clone', async () => {
    if (!createdShallowClone) return;

    const head = await getCurrentHead(shallowDir);
    expect(head).not.toBeNull();

    // The oldest commit from the origin won't have ancestry data in the shallow clone
    // This should NOT throw — it should gracefully treat as "not an ancestor"
    const ancestors = await resolveAncestorCommits(head!, [oldestCommit], shallowDir);
    expect(Array.isArray(ancestors)).toBe(true);
    // The oldest commit is NOT reachable in a depth-1 clone
    expect(ancestors).not.toContain(oldestCommit);
  });
});

describe('resolveAncestorCommits - batching and performance', () => {
  it('should handle candidates exceeding batch size (>100) via batched merge-base', async () => {
    const head = await getCurrentHead(REPO_ROOT);
    expect(head).not.toBeNull();

    // Get a real ancestor commit to use as a valid candidate
    const oldestCommit = execSync('git log --format="%H" | tail -1', {
      cwd: REPO_ROOT,
      encoding: 'utf8'
    }).trim();

    // Create 150 candidates: 1 valid + 149 fake to trigger batching (>100)
    const fakeShas = Array.from({ length: 149 }, (_, i) =>
      i.toString(16).padStart(40, '0')
    );
    const candidates = [oldestCommit, ...fakeShas];
    expect(candidates.length).toBe(150);

    const ancestors = await resolveAncestorCommits(head!, candidates, REPO_ROOT);
    // Only the real ancestor should survive
    expect(ancestors).toContain(oldestCommit);
    expect(ancestors).toHaveLength(1);
  });

  it('should produce correct results regardless of batch boundaries', async () => {
    const head = await getCurrentHead(REPO_ROOT);
    expect(head).not.toBeNull();

    // Get multiple real ancestor commits
    const realCommits = execSync('git log --format="%H" -5', {
      cwd: REPO_ROOT,
      encoding: 'utf8'
    }).trim().split('\n');

    // Pad with fakes to cross batch boundary, placing real commits at different positions
    const fakeShas = Array.from({ length: 98 }, (_, i) =>
      (i + 1000).toString(16).padStart(40, '0')
    );
    // Put real commits at positions that span batch boundaries
    const candidates = [...fakeShas.slice(0, 50), ...realCommits, ...fakeShas.slice(50)];
    expect(candidates.length).toBeGreaterThan(100);

    const ancestors = await resolveAncestorCommits(head!, candidates, REPO_ROOT);
    for (const sha of realCommits) {
      expect(ancestors).toContain(sha);
    }
    // No fakes should be in the result
    for (const sha of fakeShas) {
      expect(ancestors).not.toContain(sha);
    }
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
