import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';
import { OfflineBuffer, type BufferedRequest } from '../../src/services/infrastructure/OfflineBuffer.js';

function makeRequest(overrides: Partial<BufferedRequest> = {}): BufferedRequest {
  return {
    ts: new Date().toISOString(),
    method: 'POST',
    path: '/api/sessions/observations',
    body: { content: 'test observation' },
    node: 'test-node',
    ...overrides,
  };
}

describe('OfflineBuffer', () => {
  let tmpDir: string;
  let buffer: OfflineBuffer;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'offline-buffer-test-'));
    buffer = new OfflineBuffer(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('append()', () => {
    it('creates file and appends entries', () => {
      const req1 = makeRequest({ path: '/api/sessions/observations', node: 'node-a' });
      const req2 = makeRequest({ path: '/api/sessions/init', node: 'node-b' });

      buffer.append(req1);
      buffer.append(req2);

      const bufferPath = path.join(tmpDir, 'buffer.jsonl');
      expect(existsSync(bufferPath)).toBe(true);

      const lines = readFileSync(bufferPath, 'utf-8').trim().split('\n');
      expect(lines.length).toBe(2);
      expect(JSON.parse(lines[0]).node).toBe('node-a');
      expect(JSON.parse(lines[1]).node).toBe('node-b');
    });
  });

  describe('readAll()', () => {
    it('returns entries in FIFO order', () => {
      const req1 = makeRequest({ node: 'first' });
      const req2 = makeRequest({ node: 'second' });
      const req3 = makeRequest({ node: 'third' });

      buffer.append(req1);
      buffer.append(req2);
      buffer.append(req3);

      const entries = buffer.readAll();
      expect(entries.length).toBe(3);
      expect(entries[0].node).toBe('first');
      expect(entries[1].node).toBe('second');
      expect(entries[2].node).toBe('third');
    });

    it('returns empty array when no buffer file exists', () => {
      const freshDir = mkdtempSync(path.join(os.tmpdir(), 'offline-buffer-empty-'));
      const freshBuffer = new OfflineBuffer(freshDir);

      const entries = freshBuffer.readAll();
      expect(entries).toEqual([]);

      rmSync(freshDir, { recursive: true, force: true });
    });
  });

  describe('pendingCount()', () => {
    it('returns correct count', () => {
      expect(buffer.pendingCount()).toBe(0);

      buffer.append(makeRequest());
      expect(buffer.pendingCount()).toBe(1);

      buffer.append(makeRequest());
      buffer.append(makeRequest());
      expect(buffer.pendingCount()).toBe(3);
    });

    it('returns zero when buffer file does not exist', () => {
      const freshDir = mkdtempSync(path.join(os.tmpdir(), 'offline-buffer-count-'));
      const freshBuffer = new OfflineBuffer(freshDir);

      expect(freshBuffer.pendingCount()).toBe(0);

      rmSync(freshDir, { recursive: true, force: true });
    });
  });

  describe('replay()', () => {
    it('removes successfully replayed entries', async () => {
      buffer.append(makeRequest({ node: 'a' }));
      buffer.append(makeRequest({ node: 'b' }));
      buffer.append(makeRequest({ node: 'c' }));

      const replayed: string[] = [];
      const result = await buffer.replay(async (req) => {
        replayed.push(req.node);
        return 'ok';
      });

      expect(result.replayed).toBe(3);
      expect(result.skipped).toBe(0);
      expect(result.remaining).toBe(0);
      expect(replayed).toEqual(['a', 'b', 'c']);

      // Buffer file should be deleted
      const bufferPath = path.join(tmpDir, 'buffer.jsonl');
      expect(existsSync(bufferPath)).toBe(false);
    });

    it('stops on retry and keeps remaining', async () => {
      buffer.append(makeRequest({ node: 'a' }));
      buffer.append(makeRequest({ node: 'b' }));
      buffer.append(makeRequest({ node: 'c' }));

      let callCount = 0;
      const result = await buffer.replay(async (req) => {
        callCount++;
        // Transient failure on second entry
        return req.node === 'b' ? 'retry' : 'ok';
      });

      expect(result.replayed).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.remaining).toBe(2);
      expect(callCount).toBe(2); // called for 'a' (ok) and 'b' (retry), stopped before 'c'

      // Remaining entries should be 'b' and 'c'
      const remaining = buffer.readAll();
      expect(remaining.length).toBe(2);
      expect(remaining[0].node).toBe('b');
      expect(remaining[1].node).toBe('c');
    });

    it('skips permanently-failed entries to dead-letter and continues', async () => {
      buffer.append(makeRequest({ node: 'good1' }));
      buffer.append(makeRequest({ node: 'bad', path: '/api/test' }));
      buffer.append(makeRequest({ node: 'good2' }));

      const result = await buffer.replay(async (req) => {
        // Simulate: /api/test returns 404 (permanent), others succeed
        return req.path === '/api/test' ? 'skip' : 'ok';
      });

      expect(result.replayed).toBe(2);
      expect(result.skipped).toBe(1);
      expect(result.remaining).toBe(0);

      // Buffer should be empty
      expect(buffer.pendingCount()).toBe(0);

      // Dead-letter file should contain the skipped entry
      expect(buffer.deadLetterCount()).toBe(1);
      const dlPath = path.join(tmpDir, 'dead-letter.jsonl');
      const dlContent = readFileSync(dlPath, 'utf-8').trim();
      const dlEntry = JSON.parse(dlContent);
      expect(dlEntry.node).toBe('bad');
      expect(dlEntry.path).toBe('/api/test');
      expect(dlEntry._reason).toBe('permanent_failure');
      expect(dlEntry._deadLetterTs).toBeDefined();
    });

    it('skip + retry mixed: skips bad, stops on transient, keeps rest', async () => {
      buffer.append(makeRequest({ node: 'ok1' }));
      buffer.append(makeRequest({ node: 'skip1', path: '/api/test' }));
      buffer.append(makeRequest({ node: 'ok2' }));
      buffer.append(makeRequest({ node: 'retry1', path: '/api/sessions/observations' }));
      buffer.append(makeRequest({ node: 'ok3' }));

      const result = await buffer.replay(async (req) => {
        if (req.path === '/api/test') return 'skip';
        if (req.node === 'retry1') return 'retry';
        return 'ok';
      });

      expect(result.replayed).toBe(2);  // ok1 + ok2
      expect(result.skipped).toBe(1);   // skip1
      expect(result.remaining).toBe(2); // retry1 + ok3

      // Remaining buffer should have retry1 and ok3
      const remaining = buffer.readAll();
      expect(remaining.length).toBe(2);
      expect(remaining[0].node).toBe('retry1');
      expect(remaining[1].node).toBe('ok3');

      // Dead-letter should have skip1
      expect(buffer.deadLetterCount()).toBe(1);
    });

    it('atomic rewrite — no data loss on partial replay', async () => {
      buffer.append(makeRequest({ node: 'x' }));
      buffer.append(makeRequest({ node: 'y' }));
      buffer.append(makeRequest({ node: 'z' }));

      // Replay first two, retry on third
      const result = await buffer.replay(async (req) => {
        return req.node === 'z' ? 'retry' : 'ok';
      });

      expect(result.replayed).toBe(2);
      expect(result.remaining).toBe(1);

      // The remaining entry should be intact
      const remaining = buffer.readAll();
      expect(remaining.length).toBe(1);
      expect(remaining[0].node).toBe('z');
      expect(remaining[0].body).toEqual({ content: 'test observation' });

      // No .tmp file should remain
      const tmpPath = path.join(tmpDir, 'buffer.jsonl.tmp');
      expect(existsSync(tmpPath)).toBe(false);
    });

    it('returns zero for empty buffer', async () => {
      const result = await buffer.replay(async () => 'ok');

      expect(result.replayed).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.remaining).toBe(0);
    });

    it('concurrent replay is serialized — second call returns immediately', async () => {
      buffer.append(makeRequest({ node: 'slow' }));
      buffer.append(makeRequest({ node: 'fast' }));

      let replayCallCount = 0;

      // Start a slow replay
      const slowReplay = buffer.replay(async (req) => {
        replayCallCount++;
        // Simulate slow processing
        await new Promise(resolve => setTimeout(resolve, 100));
        return 'ok';
      });

      // Immediately start a second replay (should be serialized out)
      const concurrentResult = await buffer.replay(async () => {
        replayCallCount++;
        return 'ok';
      });

      // The concurrent call should return immediately without processing
      expect(concurrentResult.replayed).toBe(0);
      // remaining count reflects what was pending at time of check
      expect(concurrentResult.remaining).toBeGreaterThanOrEqual(0);

      // Wait for the first replay to finish
      const firstResult = await slowReplay;
      expect(firstResult.replayed).toBe(2);
      expect(firstResult.remaining).toBe(0);

      // Only the first replay should have processed entries
      expect(replayCallCount).toBe(2);
    });
  });
});
