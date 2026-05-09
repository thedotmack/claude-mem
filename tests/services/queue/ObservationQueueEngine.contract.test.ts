import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { ClaudeMemDatabase } from '../../../src/services/sqlite/Database.js';
import { createSDKSession } from '../../../src/services/sqlite/Sessions.js';
import { SqliteObservationQueueEngine } from '../../../src/server/queue/ObservationQueueEngine.js';
import type { Database } from 'bun:sqlite';

describe('ObservationQueueEngine contract', () => {
  let db: Database;
  let engine: SqliteObservationQueueEngine;
  let sessionDbId: number;
  const contentSessionId = 'engine-contract-session';

  beforeEach(() => {
    db = new ClaudeMemDatabase(':memory:').db;
    engine = new SqliteObservationQueueEngine(db);
    sessionDbId = createSDKSession(db, contentSessionId, 'test-project', 'Test prompt');
  });

  afterEach(() => {
    engine.close();
    db.close();
  });

  test('deduplicates messages by content session and tool use id', async () => {
    const firstId = await engine.enqueue(sessionDbId, contentSessionId, {
      type: 'observation',
      tool_name: 'Read',
      toolUseId: 'tool-1',
    });
    const duplicateId = await engine.enqueue(sessionDbId, contentSessionId, {
      type: 'observation',
      tool_name: 'Read',
      toolUseId: 'tool-1',
    });

    expect(firstId).toBeGreaterThan(0);
    expect(duplicateId).toBe(0);
    expect(await engine.getPendingCount(sessionDbId)).toBe(1);
  });

  test('iterator yields FIFO messages with provider metadata intact', async () => {
    const firstId = await engine.enqueue(sessionDbId, contentSessionId, {
      type: 'observation',
      tool_name: 'Read',
      tool_input: { file: 'a.ts' },
      agentId: 'agent-1',
      agentType: 'subagent',
    });
    const secondId = await engine.enqueue(sessionDbId, contentSessionId, {
      type: 'summarize',
      last_assistant_message: 'done',
    });

    const abortController = new AbortController();
    const iterator = engine.createIterator({
      sessionDbId,
      signal: abortController.signal,
    });

    const first = await iterator.next();
    const second = await iterator.next();
    abortController.abort();

    expect(first.done).toBe(false);
    expect(second.done).toBe(false);
    expect(first.value).toMatchObject({
      _persistentId: firstId,
      type: 'observation',
      tool_name: 'Read',
      tool_input: { file: 'a.ts' },
      agentId: 'agent-1',
      agentType: 'subagent',
    });
    expect(typeof first.value._originalTimestamp).toBe('number');
    expect(second.value).toMatchObject({
      _persistentId: secondId,
      type: 'summarize',
      last_assistant_message: 'done',
    });
  });

  test('resetProcessingToPending makes claimed rows visible after restart', async () => {
    const messageId = await engine.enqueue(sessionDbId, contentSessionId, {
      type: 'observation',
      tool_name: 'Grep',
    });

    const firstController = new AbortController();
    const firstIterator = engine.createIterator({
      sessionDbId,
      signal: firstController.signal,
    });
    const claimed = await firstIterator.next();
    firstController.abort();

    expect(claimed.value._persistentId).toBe(messageId);
    expect(await engine.resetProcessingToPending(sessionDbId)).toBe(1);

    const secondController = new AbortController();
    const secondIterator = engine.createIterator({
      sessionDbId,
      signal: secondController.signal,
    });
    const reclaimed = await secondIterator.next();
    secondController.abort();

    expect(reclaimed.value._persistentId).toBe(messageId);
  });

  test('iterator exits through idle timeout callback', async () => {
    const abortController = new AbortController();
    let idleTimedOut = false;

    const iterator = engine.createIterator({
      sessionDbId,
      signal: abortController.signal,
      idleTimeoutMs: 10,
      onIdleTimeout: () => {
        idleTimedOut = true;
        abortController.abort();
      },
    });

    const result = await iterator.next();

    expect(result.done).toBe(true);
    expect(idleTimedOut).toBe(true);
  });

  test('getTotalQueueDepth counts pending and processing rows across sessions', async () => {
    const otherSessionDbId = createSDKSession(db, 'engine-contract-other', 'test-project', 'Other prompt');
    await engine.enqueue(sessionDbId, contentSessionId, { type: 'observation', tool_name: 'Read' });
    await engine.enqueue(otherSessionDbId, 'engine-contract-other', { type: 'summarize' });

    const abortController = new AbortController();
    const iterator = engine.createIterator({
      sessionDbId,
      signal: abortController.signal,
    });
    await iterator.next();
    abortController.abort();

    expect(await engine.getPendingCount(sessionDbId)).toBe(1);
    expect(await engine.getPendingCount(otherSessionDbId)).toBe(1);
    expect(await engine.getTotalQueueDepth()).toBe(2);
  });
});
