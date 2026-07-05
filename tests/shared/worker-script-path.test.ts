import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveWorkerScriptPath } from '../../src/shared/worker-utils.js';

describe('resolveWorkerScriptPath', () => {
  const originalOverride = process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH;

  afterEach(() => {
    if (originalOverride === undefined) delete process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH;
    else process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH = originalOverride;
  });

  it('honors CLAUDE_MEM_WORKER_SCRIPT_PATH when the override exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-mem-worker-script-'));
    const scriptPath = join(dir, 'worker-service.cjs');
    writeFileSync(scriptPath, '');
    process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH = scriptPath;

    try {
      expect(resolveWorkerScriptPath()).toBe(scriptPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores a missing CLAUDE_MEM_WORKER_SCRIPT_PATH and preserves fallback behavior', () => {
    const missingPath = join(tmpdir(), `missing-worker-${Date.now()}-${Math.random()}.cjs`);
    process.env.CLAUDE_MEM_WORKER_SCRIPT_PATH = missingPath;

    expect(resolveWorkerScriptPath()).not.toBe(missingPath);
  });
});
