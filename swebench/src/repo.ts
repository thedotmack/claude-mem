/**
 * Per-instance repository management.
 *
 * For each SWE-bench instance we need a clean checkout of `repo` at
 * `base_commit`, let the agent modify the working tree, then extract the diff
 * as the candidate patch. Clones are cached under a workspace dir and reset
 * between instances so runs are reproducible.
 *
 * Offline/testing: if a directory already exists for the instance's repo (or
 * `localRepoPath` is provided), the network clone is skipped and that checkout
 * is reused — this is how the harness is exercised where github.com is blocked.
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './exec.ts';
import type { SweBenchInstance } from './types.ts';

export interface RepoHandle {
  /** Absolute path to the working checkout for this instance. */
  dir: string;
  /** True if a fresh clone was performed (vs. reusing an existing checkout). */
  cloned: boolean;
}

function repoSlug(repo: string): string {
  return repo.replace(/[^a-zA-Z0-9._-]/g, '__');
}

export interface PrepareOptions {
  /** Root workspace for clones (default <cwd>/repos). */
  workspace?: string;
  /** Reuse this checkout instead of cloning (offline/testing). */
  localRepoPath?: string;
  /** Clone timeout (default 300s — big repos are slow). */
  cloneTimeoutMs?: number;
  gitBaseUrl?: string;
}

/** Clone (or reuse) the instance's repo and hard-reset it to base_commit. */
export async function prepareRepo(instance: SweBenchInstance, opts: PrepareOptions = {}): Promise<RepoHandle> {
  const workspace = opts.workspace ?? join(process.cwd(), 'repos');
  mkdirSync(workspace, { recursive: true });

  if (opts.localRepoPath) {
    await resetTo(opts.localRepoPath, instance.base_commit);
    return { dir: opts.localRepoPath, cloned: false };
  }

  const dir = join(workspace, repoSlug(instance.repo));
  let cloned = false;
  if (!existsSync(join(dir, '.git'))) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    const base = opts.gitBaseUrl ?? 'https://github.com';
    const url = `${base}/${instance.repo}.git`;
    const res = await run('git', ['clone', '--quiet', url, dir], { timeoutMs: opts.cloneTimeoutMs ?? 300_000 });
    if (res.code !== 0) {
      throw new Error(`git clone failed for ${instance.repo}: ${res.stderr.slice(0, 400)}`);
    }
    cloned = true;
  }
  await resetTo(dir, instance.base_commit);
  return { dir, cloned };
}

async function resetTo(dir: string, commit: string): Promise<void> {
  // Discard any prior instance's edits, then pin to the base commit.
  await run('git', ['-C', dir, 'reset', '--hard'], { timeoutMs: 60_000 });
  await run('git', ['-C', dir, 'clean', '-fdx'], { timeoutMs: 60_000 });
  const checkout = await run('git', ['-C', dir, 'checkout', '-f', commit], { timeoutMs: 60_000 });
  if (checkout.code !== 0) {
    // The commit may not be present in a shallow clone; fetch it, then retry.
    await run('git', ['-C', dir, 'fetch', '--quiet', 'origin', commit], { timeoutMs: 120_000 });
    const retry = await run('git', ['-C', dir, 'checkout', '-f', commit], { timeoutMs: 60_000 });
    if (retry.code !== 0) {
      throw new Error(`git checkout ${commit} failed in ${dir}: ${retry.stderr.slice(0, 400)}`);
    }
  }
}

/**
 * Extract the working-tree changes as a unified diff — the SWE-bench
 * `model_patch`. Staged with `add -A` so newly created files are included, then
 * diffed against the base commit.
 */
export async function extractPatch(dir: string): Promise<string> {
  await run('git', ['-C', dir, 'add', '-A'], { timeoutMs: 60_000 });
  const res = await run('git', ['-C', dir, 'diff', '--cached', '--no-color'], {
    timeoutMs: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return res.stdout;
}
