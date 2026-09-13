import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DeferredSessionEndQueue } from '../../src/shared/deferred-session-end.js';

const temporaryDirectories: string[] = [];

function makeQueue(): DeferredSessionEndQueue {
  const directory = mkdtempSync(join(tmpdir(), 'claude-mem-session-end-replay-'));
  temporaryDirectories.push(directory);
  return new DeferredSessionEndQueue(directory);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('DeferredSessionEndQueue', () => {
  it('persists duplicate SessionEnd events as one idempotent recovery record', () => {
    const queue = makeQueue();

    queue.enqueue({ contentSessionId: 'content-session-1', platformSource: 'Claude Code' }, 100);
    queue.enqueue({ contentSessionId: 'content-session-1', platformSource: 'claude' }, 200);

    expect(queue.entries()).toEqual([{
      contentSessionId: 'content-session-1',
      platformSource: 'claude',
      requestedAtEpoch: 200,
    }]);
  });

  it('retains a replay request until a recovered worker accepts it', async () => {
    const queue = makeQueue();
    queue.enqueue({ contentSessionId: 'content-session-2', platformSource: 'cursor' }, 300);

    await expect(queue.drain(async () => false)).resolves.toEqual({ drained: 0, retained: 1 });
    expect(queue.entries()).toHaveLength(1);

    const replayed: string[] = [];
    await expect(queue.drain(async (entry) => {
      replayed.push(`${entry.platformSource}:${entry.contentSessionId}`);
      return true;
    })).resolves.toEqual({ drained: 1, retained: 0 });

    expect(replayed).toEqual(['cursor:content-session-2']);
    expect(queue.entries()).toEqual([]);
  });
});
