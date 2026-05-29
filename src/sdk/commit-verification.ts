/**
 * Commit-hash verification for summarizer output (plan-11, #2574).
 *
 * The summarizer can confabulate — inventing a nonexistent git commit hash in
 * the narrative while keeping `files_modified` accurate — which poisons every
 * future context injection that trusts it. Before persisting a summary we
 * extract any emitted commit hashes and cross-check them against ground truth
 * with `git cat-file -e <hash>` in the session's working directory. A hash that
 * does not resolve is rejected (stripped/flagged), not persisted.
 */

import { execFileSync } from 'child_process';
import { logger } from '../utils/logger.js';

// A git object id is 7–40 lowercase hex chars. We require a word boundary on
// both sides so we don't pick up the leading bytes of longer hex blobs (e.g.
// sha256 file hashes). 7 is git's conventional minimum abbreviated length.
const COMMIT_HASH_REGEX = /\b[0-9a-f]{7,40}\b/g;

/**
 * Extract candidate commit hashes from free text. Returns unique, lowercased
 * matches. Pure / no I/O so it is trivially testable.
 */
export function extractCommitHashes(text: string | null | undefined): string[] {
  if (typeof text !== 'string' || text.trim() === '') {
    return [];
  }
  const matches = text.toLowerCase().match(COMMIT_HASH_REGEX);
  if (!matches) {
    return [];
  }
  return [...new Set(matches)];
}

/**
 * Verify a single commit hash exists in the repo at `cwd` using
 * `git cat-file -e <hash>^{commit}`. Returns true only if git confirms the
 * object resolves to a commit. Any failure (not a repo, hash absent, git
 * missing) returns false — fail-fast toward rejection.
 */
export function verifyCommitHash(hash: string, cwd: string | undefined): boolean {
  if (!cwd || !cwd.trim()) {
    return false;
  }
  try {
    execFileSync('git', ['cat-file', '-e', `${hash}^{commit}`], {
      cwd,
      stdio: 'ignore',
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

export interface CommitVerificationResult {
  /** Hashes that resolved to a real commit in the repo. */
  verified: string[];
  /** Hashes that did NOT resolve — fabricated/unverifiable, must not be trusted. */
  fabricated: string[];
}

/**
 * Verify every commit hash found across the provided text fields against the
 * repo at `cwd`. Logs an ERROR with a provenance preview for any fabricated
 * hash so confabulation is traceable.
 */
export function verifyCommitHashesInText(
  fields: Array<string | null | undefined>,
  cwd: string | undefined,
  correlationId?: string | number
): CommitVerificationResult {
  const candidates = [...new Set(fields.flatMap(f => extractCommitHashes(f)))];

  // No repo to check against (cwd absent — e.g. the init-response path passes
  // projectRoot=undefined). Absence of a repo is NOT evidence of fabrication:
  // verifying every candidate as `false` here would let
  // stripFabricatedHashesFromSummary() replace every 7–40 char hex substring
  // (request IDs, short file hashes, tokens) with `[unverified commit]`,
  // silently corrupting persisted summaries. When we cannot verify, we do not
  // strip — treat all candidates as verified.
  if (!cwd || !cwd.trim()) {
    return { verified: candidates, fabricated: [] };
  }

  const verified: string[] = [];
  const fabricated: string[] = [];

  for (const hash of candidates) {
    if (verifyCommitHash(hash, cwd)) {
      verified.push(hash);
    } else {
      fabricated.push(hash);
    }
  }

  if (fabricated.length > 0) {
    logger.error('GIT', 'Summarizer emitted commit hash(es) that do not exist in the repo — rejecting fabricated claim(s)', {
      correlationId,
      cwd: cwd ?? '(none)',
      fabricated,
      verified,
    });
  }

  return { verified, fabricated };
}
