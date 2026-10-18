// Bun can throw from child_process.spawn() itself, while it sets up stdio
// ("undefined is not an object (evaluating 'NativeWritable')"). spawnGit
// called spawn() inside a Promise executor with no guard, so the throw
// rejected the promise and stopped the adoption sweep for that repo.
// A synchronous spawn throw must now come back as a git failure.
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
