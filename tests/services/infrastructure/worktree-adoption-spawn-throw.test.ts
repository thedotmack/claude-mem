// Bun can throw synchronously from child_process.spawn(). The adoption sweep
// must treat that as a failed git call and keep going, not reject.
import { describe, it, expect, afterAll, mock } from 'bun:test';
import * as realChildProcess from 'child_process';

const realChildProcessSnapshot = { ...realChildProcess };
let spawnCalls = 0;

mock.module('child_process', () => ({
  ...realChildProcessSnapshot,
  spawn: () => {
    spawnCalls++;
    throw new TypeError("undefined is not an object (evaluating 'NativeWritable')");
  },
}));

import { hasProvenAncestry } from '../../../src/services/infrastructure/WorktreeAdoption.js';

afterAll(() => {
  mock.module('child_process', () => realChildProcessSnapshot);
});

describe('worktree adoption survives a synchronous spawn throw', () => {
  it('treats the throw as a failed git call instead of rejecting', async () => {
    const proven = await hasProvenAncestry('/repo', 'deadbeef', new Set(['cafebabe', 'f00dface']));
    expect(proven).toBe(false);
    expect(spawnCalls).toBe(2);
  });
});
