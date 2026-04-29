
import { describe, it, expect } from 'bun:test';
import { ensureWorkerStarted } from '../../src/services/worker-spawner.js';

describe('ensureWorkerStarted validation guards', () => {

  it('returns false when workerScriptPath is empty string', async () => {
    const result = await ensureWorkerStarted(39001, '');
    expect(result).toBe(false);
  });

  it('returns false when workerScriptPath does not exist on disk', async () => {
    const bogusPath = '/tmp/__claude-mem-test-nonexistent-worker-script-' + Date.now() + '.cjs';
    const result = await ensureWorkerStarted(39002, bogusPath);
    expect(result).toBe(false);
  });
});
