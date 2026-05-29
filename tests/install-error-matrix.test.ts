import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  ErrorSeverity,
  classifyError,
  ERROR_CATEGORIES,
} from '../src/npx-cli/install/error-taxonomy';
import {
  createInstallSummary,
  installerError,
  flushSummary,
  withRetry,
  InstallAbortError,
} from '../src/npx-cli/install/error-reporter';
import {
  isEresolve,
  extractEresolveBlock,
} from '../src/npx-cli/install/npm-install-helper';

const CANONICAL_IDES = [
  'claude-code',
  'gemini-cli',
  'opencode',
  'openclaw',
  'windsurf',
  'codex-cli',
  'cursor',
  'copilot-cli',
  'antigravity',
  'goose',
  'roo-code',
  'warp',
];

describe('error taxonomy', () => {
  it('exposes ErrorSeverity, ERROR_CATEGORIES, classifyError', () => {
    expect(ErrorSeverity.ABORT).toBe('ABORT');
    expect(Array.isArray(ERROR_CATEGORIES)).toBe(true);
    expect(ERROR_CATEGORIES.length).toBeGreaterThanOrEqual(13);
  });

  it('has no SILENT severity (only SILENT_RETRY)', () => {
    const severities = new Set(ERROR_CATEGORIES.map((c) => c.severity));
    expect(severities.has('SILENT' as ErrorSeverity)).toBe(false);
  });

  it('classifies a missing bun error as ABORT (bun-missing-after-install)', () => {
    const cat = classifyError(new Error('Bun executable not found after install attempt.'), {
      component: 'bun-install',
      phase: 'setup-runtime',
    });
    expect(cat.id).toBe('bun-missing-after-install');
    expect(cat.severity).toBe(ErrorSeverity.ABORT);
  });

  it('classifies a missing uv error as ABORT (uv-missing-after-install)', () => {
    const cat = classifyError(new Error('uv installed but version probe failed.'), {
      component: 'uv-install',
      phase: 'setup-runtime',
    });
    expect(cat.id).toBe('uv-missing-after-install');
  });

  it('classifies ERESOLVE stderr as tree-sitter-eresolve ABORT', () => {
    const cat = classifyError(new Error('npm error code ERESOLVE\nWhile resolving: x'), {
      component: 'marketplace-npm-install',
      phase: 'marketplace-deps',
    });
    expect(cat.id).toBe('tree-sitter-eresolve');
    expect(cat.severity).toBe(ErrorSeverity.ABORT);
  });

  it('defaults unknown errors to ABORT (fail-loud)', () => {
    const cat = classifyError(new Error('something we have never seen'), {
      component: 'mystery',
      phase: 'mystery',
    });
    expect(cat.severity).toBe(ErrorSeverity.ABORT);
    expect(cat.id).toBe('unknown-install-error');
  });

  it('remediation strings interpolate the passed dataDir, never a hardcoded path', () => {
    const cat = ERROR_CATEGORIES.find((c) => c.id === 'marketplace-dir-not-writable')!;
    const text = cat.remediation({ platform: 'linux', dataDir: '/custom/data/dir' });
    expect(text).toContain('/custom/data/dir');
  });
});

describe('installerError decision logic', () => {
  let home: string;
  let prevDataDir: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cm-installer-'));
    prevDataDir = process.env.CLAUDE_MEM_DATA_DIR;
    process.env.CLAUDE_MEM_DATA_DIR = home;
  });

  afterEach(() => {
    if (prevDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
    else process.env.CLAUDE_MEM_DATA_DIR = prevDataDir;
    rmSync(home, { recursive: true, force: true });
  });

  it('ABORT throws InstallAbortError and writes last-install-error.json', () => {
    const summary = createInstallSummary();
    let thrown: unknown;
    try {
      installerError(ErrorSeverity.ABORT, {
        component: 'marketplace-npm-install',
        phase: 'marketplace-deps',
        cause: new Error('npm error code ERESOLVE'),
        details: 'While resolving: foo@1',
      }, summary);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(InstallAbortError);
    const abort = thrown as InstallAbortError;
    expect(abort.category.id).toBe('tree-sitter-eresolve');
    expect(abort.remediation.length).toBeGreaterThan(0);

    const recordPath = join(home, 'last-install-error.json');
    expect(existsSync(recordPath)).toBe(true);
    const record = JSON.parse(readFileSync(recordPath, 'utf-8'));
    expect(record.categoryId).toBe('tree-sitter-eresolve');
    expect(record.severity).toBe('ABORT');
    expect(record.details).toContain('While resolving');
  });

  it('WARN_CONTINUE appends to summary and does not throw', () => {
    const summary = createInstallSummary();
    installerError(ErrorSeverity.WARN_CONTINUE, {
      component: 'auto-memory',
      phase: 'post-ide',
      cause: new Error('could not write settings'),
    }, summary);
    expect(summary.warnings).toHaveLength(1);
    expect(summary.warnings[0].component).toBe('auto-memory');
    expect(summary.failedIDEs).toHaveLength(0);
  });

  it('FAIL_LOUD_PER_IDE records the IDE and a warning, no throw', () => {
    const summary = createInstallSummary();
    installerError(ErrorSeverity.FAIL_LOUD_PER_IDE, {
      component: 'Cursor: hook installation failed',
      ide: 'cursor',
      phase: 'ide-install',
      cause: new Error('Cursor: hook installation failed'),
      details: 'EACCES: permission denied',
    }, summary);
    expect(summary.failedIDEs).toEqual(['cursor']);
    expect(summary.warnings[0].message).toContain('EACCES');
  });

  it('SILENT_RETRY stays silent on first occurrence, escalates on second', () => {
    const summary = createInstallSummary();
    const ctx = { component: 'bun-net', phase: 'setup-runtime', cause: new Error('error: failed to resolve') };
    installerError(ErrorSeverity.SILENT_RETRY, ctx, summary);
    expect(summary.warnings).toHaveLength(0);
    expect(summary.retryCount['bun-net']).toBe(1);
    installerError(ErrorSeverity.SILENT_RETRY, ctx, summary);
    expect(summary.warnings).toHaveLength(1);
    expect(summary.retryCount['bun-net']).toBe(2);
  });

  it('withRetry retries once then rethrows', async () => {
    const summary = createInstallSummary();
    let calls = 0;
    await expect(
      withRetry(async () => { calls++; throw new Error('boom'); }, {
        component: 'x', phase: 'y', cause: undefined,
      }, summary, 2),
    ).rejects.toThrow('boom');
    expect(calls).toBe(2);
  });

  it('flushSummary emits each warning with remediation', () => {
    const summary = createInstallSummary();
    installerError(ErrorSeverity.WARN_CONTINUE, {
      component: 'auto-memory', phase: 'post-ide', cause: new Error('nope'),
    }, summary);
    const lines: string[] = [];
    flushSummary(summary, (l) => lines.push(l));
    const blob = lines.join('\n');
    expect(blob).toContain('Warnings & remediation');
    expect(blob).toContain('auto-memory');
  });
});

describe('npm install ERESOLVE detection', () => {
  it('detects an uppercase ERESOLVE token', () => {
    expect(isEresolve('npm error code ERESOLVE\nWhile resolving:')).toBe(true);
  });

  it('does NOT treat a generic failure as ERESOLVE', () => {
    expect(isEresolve('npm error 404 Not Found')).toBe(false);
  });

  it('extracts the While-resolving conflict block', () => {
    const stderr = 'npm error code ERESOLVE\nnpm error While resolving: a@1\nnpm error Conflicting peer dependency: b@2';
    const block = extractEresolveBlock(stderr);
    expect(block).toContain('While resolving');
    expect(block).toContain('Conflicting peer dependency');
  });

  it('returns raw stderr when the block markers are absent (defensive)', () => {
    const block = extractEresolveBlock('ERESOLVE happened but no markers');
    expect(block).toContain('ERESOLVE happened');
  });
});

/**
 * Cross-IDE failure-mode matrix. We exercise the taxonomy/decision logic that
 * drives each install outcome for every IDE without spawning real npm/bun (the
 * directive: test the decision logic + summary rendering, not the network).
 *
 * For each IDE × scenario we assert: the install STATUS (Complete vs Partial vs
 * Aborted), whether an InstallAbortError is thrown, exit semantics (would-exit-1),
 * and that remediation text is present where expected.
 */
type Scenario = 'happy' | 'eresolve' | 'missing-uv' | 'missing-bun';

interface Outcome {
  status: 'Complete' | 'Partial' | 'Aborted';
  aborted: boolean;
  remediation?: string;
}

/**
 * Pure model of the installer's decision path for one IDE + one failure mode.
 * Mirrors how install.ts routes each scenario through installerError.
 */
function simulateInstall(_ide: string, scenario: Scenario): Outcome {
  const summary = createInstallSummary();
  try {
    switch (scenario) {
      case 'happy':
        // no errors -> Complete
        break;
      case 'eresolve':
        installerError(ErrorSeverity.ABORT, {
          component: 'marketplace-npm-install',
          phase: 'marketplace-deps',
          cause: new Error('npm error code ERESOLVE\nWhile resolving: tree-sitter'),
        }, summary);
        break;
      case 'missing-uv':
        installerError(ErrorSeverity.ABORT, {
          component: 'uv-install',
          phase: 'setup-runtime',
          cause: new Error('uv binary not found after auto-install attempt'),
        }, summary);
        break;
      case 'missing-bun':
        installerError(ErrorSeverity.ABORT, {
          component: 'bun-install',
          phase: 'setup-runtime',
          cause: new Error('Bun executable not found after auto-install attempt'),
        }, summary);
        break;
    }
  } catch (e) {
    if (e instanceof InstallAbortError) {
      return { status: 'Aborted', aborted: true, remediation: e.remediation };
    }
    throw e;
  }
  const status = summary.failedIDEs.length > 0 ? 'Partial' : 'Complete';
  return { status, aborted: false };
}

describe('cross-IDE failure matrix (12 IDEs x 4 scenarios)', () => {
  const scenarios: Scenario[] = ['happy', 'eresolve', 'missing-uv', 'missing-bun'];

  beforeEach(() => {
    process.env.CLAUDE_MEM_DATA_DIR = mkdtempSync(join(tmpdir(), 'cm-matrix-'));
  });
  afterEach(() => {
    const dir = process.env.CLAUDE_MEM_DATA_DIR;
    if (dir) rmSync(dir, { recursive: true, force: true });
    delete process.env.CLAUDE_MEM_DATA_DIR;
  });

  it('produces 48 cells (12 IDEs x 4 scenarios)', () => {
    expect(CANONICAL_IDES.length * scenarios.length).toBe(48);
  });

  for (const ide of CANONICAL_IDES) {
    for (const scenario of scenarios) {
      it(`${ide} / ${scenario}`, () => {
        const outcome = simulateInstall(ide, scenario);
        if (scenario === 'happy') {
          expect(outcome.status).toBe('Complete');
          expect(outcome.aborted).toBe(false);
        } else {
          // Every failure mode must ABORT (exit 1) — never "Complete".
          expect(outcome.status).toBe('Aborted');
          expect(outcome.aborted).toBe(true);
          expect(outcome.remediation && outcome.remediation.length).toBeGreaterThan(0);
        }

        if (scenario === 'missing-uv') {
          expect(outcome.remediation).toContain('uv');
        }
        if (scenario === 'missing-bun') {
          expect(outcome.remediation).toContain('Bun');
        }
        if (scenario === 'eresolve') {
          expect(outcome.remediation).toContain('ERESOLVE');
        }
      });
    }
  }
});
