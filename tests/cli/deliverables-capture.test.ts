import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { boundedErrors, deliverableRoots, isOutsideSourceTree, resolveCandidatePath, type GitRunner, type RepositoryLookup } from '../../src/cli/deliverables-capture.js';
import { DELIVERABLE_ERRORS_PER_EVENT } from '../../src/shared/hook-spool.js';
import { logger } from '../../src/utils/logger.js';

let dir: string;
let warnings: ReturnType<typeof spyOn>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'claude-mem-capture-'));
  warnings = spyOn(logger, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnings.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

describe('isOutsideSourceTree', () => {
  it('with real git: a file in an ignored folder or outside any repository is outside; a source file is not', () => {
    const repo = join(dir, 'repo');
    mkdirSync(join(repo, '.scratch'), { recursive: true });
    mkdirSync(join(repo, 'src'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    writeFileSync(join(repo, '.gitignore'), '.scratch/\n');
    writeFileSync(join(repo, '.scratch', 'report.html'), 'x');
    writeFileSync(join(repo, 'src', 'page.html'), 'x');
    writeFileSync(join(dir, 'notes.md'), 'x');
    const cache = new Map<string, RepositoryLookup>();
    expect(isOutsideSourceTree(join(repo, '.scratch', 'report.html'), cache)).toBe(true);
    expect(isOutsideSourceTree(join(repo, 'src', 'page.html'), cache)).toBe(false);
    expect(isOutsideSourceTree(join(dir, 'notes.md'), cache)).toBe(true);
    expect(cache.get(join(repo, 'src'))).toEqual({ kind: 'repository', root: execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: repo, encoding: 'utf-8' }).trim() });
    expect(cache.get(dir)).toEqual({ kind: 'none' });
  });

  it('treats a failed git check as unknown, not as outside a repository, so nothing is copied on it', () => {
    const file = join(dir, 'report.html');
    writeFileSync(file, 'x');
    const answers: Record<string, GitRunner> = {
      // git is not installed, or hung past its timeout: no exit status at all.
      missing: () => ({ status: null, stdout: '', stderr: '' }),
      // git refuses the repository it finds (safe.directory): the same exit code as "not a repository", a different message.
      dubious: () => ({ status: 128, stdout: '', stderr: "fatal: detected dubious ownership in repository at '/repo'\n" }),
      // Any other failure.
      broken: () => ({ status: 1, stdout: '', stderr: 'error: something else\n' }),
    };
    for (const [name, git] of Object.entries(answers)) {
      const cache = new Map<string, RepositoryLookup>();
      expect(isOutsideSourceTree(file, cache, git)).toBe(false);
      expect(cache.get(dir)?.kind).toBe('unknown');
      expect(warnings).toHaveBeenCalledTimes(1);
      warnings.mockClear();
      // One folder, one lookup: the second file in it asks git nothing.
      expect(isOutsideSourceTree(join(dir, 'other.html'), cache, git)).toBe(false);
      expect(warnings).not.toHaveBeenCalled();
      void name;
    }
    // Git's own answer for a folder no repository holds is the one confirmation of "outside".
    const outside: GitRunner = () => ({ status: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git\n' });
    expect(isOutsideSourceTree(file, new Map(), outside)).toBe(true);
    expect(warnings).not.toHaveBeenCalled();
  });
});

describe('boundedErrors', () => {
  it('keeps the list within the remote schema\'s bound and says how many were cut', () => {
    const errors = Array.from({ length: DELIVERABLE_ERRORS_PER_EVENT + 51 }, (_, i) => ({ sourcePath: `/w/${i}.pdf`, error: 'over the limit' }));
    expect(boundedErrors(errors.slice(0, DELIVERABLE_ERRORS_PER_EVENT))).toHaveLength(DELIVERABLE_ERRORS_PER_EVENT);
    const bounded = boundedErrors(errors);
    expect(bounded).toHaveLength(DELIVERABLE_ERRORS_PER_EVENT);
    expect(bounded.slice(0, -1)).toEqual(errors.slice(0, DELIVERABLE_ERRORS_PER_EVENT - 1));
    expect(bounded.at(-1)).toEqual({ sourcePath: '', error: '52 more files were not copied; the hook log names each one' });
  });
});

describe('resolveCandidatePath', () => {
  it('accepts a file inside the checkout or the temp folders and refuses one elsewhere, through a symlink too', () => {
    const checkout = join(dir, 'checkout');
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(join(checkout, '.scratch'), { recursive: true });
    mkdirSync(elsewhere);
    writeFileSync(join(checkout, '.scratch', 'report.html'), 'x');
    writeFileSync(join(elsewhere, 'id_rsa'), 'secret');
    // The temp dir this test runs in is itself inside the temp folders, so the roots are made explicit.
    const roots = [realpathSync(checkout)];
    expect(resolveCandidatePath('.scratch/report.html', checkout, roots)).toBe(join(checkout, '.scratch', 'report.html'));
    expect(resolveCandidatePath(join(checkout, '.scratch', 'report.html'), checkout, roots)).toBe(join(checkout, '.scratch', 'report.html'));
    expect(resolveCandidatePath(join(elsewhere, 'id_rsa'), checkout, roots)).toBeNull();
    expect(warnings).toHaveBeenCalledTimes(1);
    expect(resolveCandidatePath('../elsewhere/id_rsa', checkout, roots)).toBeNull();
    let symlinked = false;
    try { symlinkSync(join(elsewhere, 'id_rsa'), join(checkout, '.scratch', 'notes.md')); symlinked = true; } catch { /* no symlinks on this host */ }
    if (symlinked) expect(resolveCandidatePath('.scratch/notes.md', checkout, roots)).toBeNull();
    // Not files, or not there: no warning, just nothing.
    warnings.mockClear();
    expect(resolveCandidatePath(join(checkout, '.scratch'), checkout, roots)).toBeNull();
    expect(resolveCandidatePath(join(checkout, 'missing.pdf'), checkout, roots)).toBeNull();
    expect(resolveCandidatePath('https://example.com/report.pdf', checkout, roots)).toBeNull();
    expect(warnings).not.toHaveBeenCalled();
  });

  it('roots are the checkout and the temp folders, realpath\'d, and only the ones that exist', () => {
    const roots = deliverableRoots(dir);
    expect(roots).toContain(realpathSync(dir));
    expect(roots).toContain(realpathSync(tmpdir()));
    expect(roots.every(root => !root.endsWith('/') || root === '/')).toBe(true);
    expect(deliverableRoots(join(dir, 'missing'))).not.toContain(join(dir, 'missing'));
  });
});
