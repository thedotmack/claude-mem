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
