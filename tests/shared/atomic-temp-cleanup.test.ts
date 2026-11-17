// The hand-written atomic writers name their temp file randomly, so a write
// or rename that fails (on Windows, EPERM/EBUSY while antivirus or the indexer
// holds the target) must remove the temp: with a random name, nothing would
// ever reuse it, and every failure would leave one more file behind.
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeSyncHealth } from '../../src/shared/sync-health.js';
import { writeSetupState } from '../../src/shared/setup-state.js';

let directory: string | undefined;

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

/** A target the rename cannot replace: a directory that is not empty. */
function unreplaceableTarget(): string {
  directory = mkdtempSync(join(tmpdir(), 'atomic-temp-cleanup-'));
  const target = join(directory, 'state.json');
  mkdirSync(target);
  writeFileSync(join(target, 'keep'), 'x');
  return target;
}

const tempsIn = (path: string): string[] => readdirSync(path).filter(name => name.endsWith('.tmp'));

describe('atomic writers remove their temp when the rename fails', () => {
  it('writeSyncHealth (logs and carries on)', () => {
    const target = unreplaceableTarget();
    writeSyncHealth({
      state: 'ok', code: null, message: null, consecutiveFailures: 0,
      failingSinceAt: null, lastErrorAt: null, lastSuccessAt: 1, updatedAt: 1,
    }, target);
    expect(tempsIn(directory!)).toEqual([]);
  });

  it('writeSetupState (rethrows)', () => {
    const target = unreplaceableTarget();
    expect(() => writeSetupState({
      status: 'pending', choice: null, installer: null, checkout: null, tools: null, completedAt: null,
    }, target)).toThrow();
    expect(tempsIn(directory!)).toEqual([]);
  });
});
