// tests/shared/worker-script-path.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveWorkerScriptPath } from '../../src/shared/worker-utils.js';

describe('resolveWorkerScriptPath — CLAUDE_MEM_WORKER_SCRIPT_PATH override', () => {
  let tempDir: string;
  let existingScript: string;
  const orig = process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'wsp-'));
    existingScript = join(tempDir, 'worker-service.cjs');
    writeFileSync(existingScript, '// stub', 'utf-8');
    delete process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH;
  });

  afterEach(() => {
    if (orig === undefined) delete process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH;
    else process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH = orig;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns the override path when set and existing (wins over defaults)', () => {
    process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH = existingScript;
    expect(resolveWorkerScriptPath()).toBe(existingScript);
  });

  it('ignores a set-but-nonexistent override (identical to unset)', () => {
    // baseline = whatever default resolution produces on this host (marketplace
    // path locally, null in CI). We assert relative behavior, not an absolute.
    const unsetResult = resolveWorkerScriptPath(); // env unset in beforeEach
    process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH = join(tempDir, 'does-not-exist.cjs');
    expect(resolveWorkerScriptPath()).toBe(unsetResult);
  });

  it('ignores an empty-string override (identical to unset)', () => {
    // baseline = host-dependent default resolution (see above); relative assert.
    const unsetResult = resolveWorkerScriptPath();
    process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH = '';
    expect(resolveWorkerScriptPath()).toBe(unsetResult);
  });
});
