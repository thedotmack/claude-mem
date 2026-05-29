import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import {
  extractCommitHashes,
  verifyCommitHash,
  verifyCommitHashesInText,
} from '../../src/sdk/commit-verification.js';

describe('extractCommitHashes', () => {
  it('extracts a 40-char hash', () => {
    expect(extractCommitHashes('fixed in c3d2af7c8b1e2f3a4d5c6b7a8e9f0a1b2c3d4e5f now')).toEqual([
      'c3d2af7c8b1e2f3a4d5c6b7a8e9f0a1b2c3d4e5f',
    ]);
  });

  it('extracts a short (7-char) hash', () => {
    expect(extractCommitHashes('see commit c3d2af7 for details')).toEqual(['c3d2af7']);
  });

  it('lowercases and dedupes', () => {
    expect(extractCommitHashes('C3D2AF7 and c3d2af7')).toEqual(['c3d2af7']);
  });

  it('returns empty for prose with no hashes', () => {
    expect(extractCommitHashes('I refactored the parser and added tests.')).toEqual([]);
  });

  it('returns empty for null/empty input', () => {
    expect(extractCommitHashes(null)).toEqual([]);
    expect(extractCommitHashes('')).toEqual([]);
  });
});

describe('verifyCommitHash / verifyCommitHashesInText (plan-11 #2574)', () => {
  let repoDir: string;
  let realHash: string;
  let scratchRoot: string;

  beforeAll(() => {
    // Per project policy, keep scratch inside the repo (gitignored), not /tmp.
    scratchRoot = join(process.cwd(), '.scratch');
    mkdirSync(scratchRoot, { recursive: true });
    repoDir = mkdtempSync(join(scratchRoot, 'commit-verify-'));

    execFileSync('git', ['init', '-q'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
    writeFileSync(join(repoDir, 'file.txt'), 'hello');
    execFileSync('git', ['add', '.'], { cwd: repoDir });
    execFileSync('git', ['commit', '-q', '-m', 'initial commit'], { cwd: repoDir });
    realHash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir }).toString().trim();
  });

  afterAll(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('verifies a real commit hash', () => {
    expect(verifyCommitHash(realHash, repoDir)).toBe(true);
  });

  it('rejects a fabricated commit hash', () => {
    expect(verifyCommitHash('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', repoDir)).toBe(false);
  });

  it('rejects when cwd is missing', () => {
    expect(verifyCommitHash(realHash, undefined)).toBe(false);
  });

  it('splits real vs fabricated hashes across text fields', () => {
    const result = verifyCommitHashesInText(
      [`Committed as ${realHash}`, 'Also see deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'],
      repoDir
    );
    expect(result.verified).toContain(realHash.toLowerCase());
    expect(result.fabricated).toContain('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
  });

  it('treats all candidates as verified (never fabricated) when cwd is absent', () => {
    // Regression: a null/undefined cwd must NOT classify every hex string as
    // fabricated — otherwise stripFabricatedHashesFromSummary corrupts summaries
    // (request IDs, short file hashes) on the init-response path.
    for (const cwd of [undefined, '', '   ']) {
      const result = verifyCommitHashesInText(
        [`Committed as ${realHash}`, 'Also see deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'],
        cwd
      );
      expect(result.fabricated).toEqual([]);
      expect(result.verified).toContain(realHash.toLowerCase());
      expect(result.verified).toContain('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    }
  });
});
