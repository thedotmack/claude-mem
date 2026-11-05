import { describe, test, expect } from 'bun:test';
import { SessionMessageBuffer } from '../../../src/services/worker/SessionMessageBuffer.js';
import type { PendingMessage, PendingMessageWithId } from '../../../src/services/worker-types.js';

function obs(toolName: string, toolUseId?: string): PendingMessage {
  return { type: 'observation', tool_name: toolName, tool_input: {}, tool_response: {}, toolUseId };
}

/** Drain everything currently buffered, ending the iterator via a tiny idle timeout. */
async function drainAll(buffer: SessionMessageBuffer, sessionDbId: number): Promise<PendingMessageWithId[]> {
  const controller = new AbortController();
  const collected: PendingMessageWithId[] = [];
  for await (const msg of buffer.drain({
    sessionDbId,
    signal: controller.signal,
    idleTimeoutMs: 30,
    onIdleTimeout: () => controller.abort(),
  })) {
    collected.push(msg);
  }
  return collected;
}

describe('SessionMessageBuffer (in-RAM observation buffer)', () => {
  test('enqueue assigns increasing ids and reports depth', () => {
    const buffer = new SessionMessageBuffer();
    const id1 = buffer.enqueue(1, obs('Read'));
    const id2 = buffer.enqueue(1, obs('Write'));
    expect(id2).toBeGreaterThan(id1);
    expect(buffer.getPendingCount(1)).toBe(2);
    expect(buffer.getTotalDepth()).toBe(2);
  });

  test('dedups observations by toolUseId within a session, but never dedups summarize/no-id', () => {
    const buffer = new SessionMessageBuffer();
    expect(buffer.enqueue(1, obs('Read', 'tool-abc'))).toBeGreaterThan(0);
    expect(buffer.enqueue(1, obs('Read', 'tool-abc'))).toBe(0); // duplicate suppressed
    expect(buffer.enqueue(1, obs('Read'))).toBeGreaterThan(0);  // no id → not deduped
    expect(buffer.enqueue(1, obs('Read'))).toBeGreaterThan(0);  // no id → not deduped
    // same toolUseId in a different session is independent
    expect(buffer.enqueue(2, obs('Read', 'tool-abc'))).toBeGreaterThan(0);
  });

  test('drain yields buffered messages in FIFO order with id + timestamp', async () => {
    const buffer = new SessionMessageBuffer();
    buffer.enqueue(1, obs('Read', 'a'));
    buffer.enqueue(1, obs('Write', 'b'));
    const drained = await drainAll(buffer, 1);
    expect(drained.map(m => m.tool_name)).toEqual(['Read', 'Write']);
    expect(drained[0]._persistentId).toBeGreaterThan(0);
    expect(typeof drained[0]._originalTimestamp).toBe('number');
  });

  test('confirm removes a message; resetClaimed makes claimed messages re-drainable', async () => {
    const buffer = new SessionMessageBuffer();
    const id = buffer.enqueue(1, obs('Read', 'a'));
    buffer.enqueue(1, obs('Write', 'b'));

    // First drain claims both.
    const first = await drainAll(buffer, 1);
    expect(first.length).toBe(2);
    // Nothing confirmed yet → still buffered.
    expect(buffer.getPendingCount(1)).toBe(2);

    // Confirm one → depth drops.
    expect(buffer.confirm(id)).toBe(1);
    expect(buffer.getPendingCount(1)).toBe(1);

    // resetClaimed re-yields the remaining (claimed-but-unconfirmed) one.
    expect(buffer.resetClaimed(1)).toBe(1);
    const second = await drainAll(buffer, 1);
    expect(second.map(m => m.tool_name)).toEqual(['Write']);
  });

  test('clear empties a session; dispose forgets it', () => {
    const buffer = new SessionMessageBuffer();
    buffer.enqueue(1, obs('Read', 'a'));
    buffer.enqueue(1, obs('Write', 'b'));
    expect(buffer.clear(1)).toBe(2);
    expect(buffer.getPendingCount(1)).toBe(0);
    // dispose also clears the dedup memory, so the same toolUseId can re-enter.
    buffer.enqueue(1, obs('Read', 'a'));
    buffer.dispose(1);
    expect(buffer.enqueue(1, obs('Read', 'a'))).toBeGreaterThan(0);
  });

  test('clear also resets the dedup set so a previously-seen toolUseId re-enters', () => {
    // Regression: clear() must drop seenToolUseIds like dispose() does.
    // Otherwise a clear() not followed by dispose() leaves the dedup set intact
    // and a later enqueue of a previously-seen toolUseId is silently lost (0).
    const buffer = new SessionMessageBuffer();
    expect(buffer.enqueue(1, obs('Read', 'a'))).toBeGreaterThan(0);
    expect(buffer.clear(1)).toBe(1);
    expect(buffer.enqueue(1, obs('Read', 'a'))).toBeGreaterThan(0); // not suppressed
  });

  test('clearUnclaimed preserves in-flight evidence and drops only unsent work', async () => {
    const buffer = new SessionMessageBuffer();
    const confirmedId = buffer.enqueue(1, obs('Read', 'confirmed'));
    expect(buffer.confirm(confirmedId)).toBe(1);
    const claimedId = buffer.enqueue(1, obs('Read', 'claimed'));
    buffer.enqueue(1, obs('Write', 'unsent'));
    const controller = new AbortController();
    const iterator = buffer.drain({ sessionDbId: 1, signal: controller.signal });

    expect((await iterator.next()).value?._persistentId).toBe(claimedId);
    expect(buffer.clearUnclaimed(1)).toBe(1);
    expect(buffer.getMessagesByIds(1, [claimedId])).toHaveLength(1);
    expect(buffer.enqueue(1, obs('Read', 'confirmed'))).toBe(0);
    expect(buffer.enqueue(1, obs('Read', 'claimed'))).toBe(0);
    expect(buffer.enqueue(1, obs('Write', 'unsent'))).toBeGreaterThan(0);

    controller.abort();
    await iterator.return?.(undefined);
  });

  test('drain ends via idle timeout when no work arrives', async () => {
    const buffer = new SessionMessageBuffer();
    const controller = new AbortController();
    let idleFired = false;
    const start = Date.now();
    const iterated: PendingMessageWithId[] = [];
    for await (const msg of buffer.drain({
      sessionDbId: 99,
      signal: controller.signal,
      idleTimeoutMs: 25,
      onIdleTimeout: () => { idleFired = true; controller.abort(); },
    })) {
      iterated.push(msg);
    }
    expect(idleFired).toBe(true);
    expect(iterated.length).toBe(0);
    expect(Date.now() - start).toBeGreaterThanOrEqual(20);
  });

  test('drain releases the idle slot early while slot waiters are parked (#5376)', async () => {
    const buffer = new SessionMessageBuffer();
    const controller = new AbortController();
    let idleFired = false;
    const start = Date.now();
    const iterated: PendingMessageWithId[] = [];
    for await (const msg of buffer.drain({
      sessionDbId: 100,
      signal: controller.signal,
      idleTimeoutMs: 6000,
      shouldReleaseIdleSlot: () => true,
      onIdleTimeout: () => { idleFired = true; controller.abort(); },
    })) {
      iterated.push(msg);
    }
    expect(idleFired).toBe(true);
    expect(iterated.length).toBe(0);
    // Ended on the contention recheck (~1s slices), not the 6s idle timeout.
    expect(Date.now() - start).toBeLessThan(3000);
  }, 10000);

  test('drain keeps the full idle timeout while no slot waiters are parked (#5376)', async () => {
    const buffer = new SessionMessageBuffer();
    const controller = new AbortController();
    let idleFired = false;
    const start = Date.now();
    const iterated: PendingMessageWithId[] = [];
    for await (const msg of buffer.drain({
      sessionDbId: 101,
      signal: controller.signal,
      idleTimeoutMs: 300,
      shouldReleaseIdleSlot: () => false,
      onIdleTimeout: () => { idleFired = true; controller.abort(); },
    })) {
      iterated.push(msg);
    }
    expect(idleFired).toBe(true);
    expect(iterated.length).toBe(0);
    expect(Date.now() - start).toBeGreaterThanOrEqual(250);
  });

  test('drain starts the idle clock when the consumer returns, not when a message is claimed (#5376)', async () => {
    const buffer = new SessionMessageBuffer();
    buffer.enqueue(102, obs('Read', 'a'));
    const controller = new AbortController();
    let idleFiredAt: number | null = null;
    const iterator = buffer.drain({
      sessionDbId: 102,
      signal: controller.signal,
      idleTimeoutMs: 1500,
      onIdleTimeout: () => { idleFiredAt = Date.now(); },
    });
    const first = await iterator.next();
    expect(first.done).toBe(false);
    // Simulate a slow reply: the consumer holds the message for 1.2s before
    // asking for the next one.
    await new Promise(resolve => setTimeout(resolve, 1200));
    const returnedAt = Date.now();
    const second = await iterator.next();
    expect(second.done).toBe(true);
    expect(idleFiredAt).not.toBeNull();
    // The full 1.5s idle window runs from the consumer's return. Waits are
    // sliced at 1s, so it fires on the second slice (~2s after the return).
    // A clock stamped at claim time would already fire on the first slice
    // (~1s after the return), its 1.2s of processing having counted as idle.
    expect(idleFiredAt! - returnedAt).toBeGreaterThanOrEqual(1800);
    controller.abort();
  }, 10000);

  test('peekTypes reflects buffered message types', () => {
    const buffer = new SessionMessageBuffer();
    buffer.enqueue(1, obs('Read', 'a'));
    buffer.enqueue(1, { type: 'summarize', last_assistant_message: 'done' });
    const types = buffer.peekTypes(1);
    expect(types).toEqual([
      { message_type: 'observation', tool_name: 'Read' },
      { message_type: 'summarize', tool_name: null },
    ]);
  });
});
