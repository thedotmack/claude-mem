import { describe, expect, it } from 'bun:test';
import { readCappedErrorBody } from '../../src/shared/capped-error-body.js';

describe('readCappedErrorBody reader ownership', () => {
  it('releases a response after reaching EOF', async () => {
    const response = new Response('provider error');
    expect(await readCappedErrorBody(response)).toBe('provider error');
    expect(response.body?.locked).toBe(false);
  });

  it('cancels and unlocks the stream after reaching the byte cap', async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('abcdef')); },
      cancel() { cancelled = true; },
    }));
    expect(await readCappedErrorBody(response, 3)).toBe('abc');
    expect(cancelled).toBe(true);
    expect(response.body?.locked).toBe(false);
  });

  it('releases the lock while preserving a read failure', async () => {
    const failure = new Error('upstream disconnected');
    const response = new Response(new ReadableStream({
      start(controller) { controller.error(failure); },
    }));
    await expect(readCappedErrorBody(response)).rejects.toBe(failure);
    expect(response.body?.locked).toBe(false);
  });

  it('releases the lock even if cancellation rejects', async () => {
    const failure = new Error('cancel rejected');
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('abcdef')); },
      cancel() { return Promise.reject(failure); },
    }));
    await expect(readCappedErrorBody(response, 3)).rejects.toBe(failure);
    expect(response.body?.locked).toBe(false);
  });

  it('decodes a UTF-8 character split between chunks', async () => {
    const bytes = new TextEncoder().encode('rate limited ✓');
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.slice(0, -1));
        controller.enqueue(bytes.slice(-1));
        controller.close();
      },
    }));
    expect(await readCappedErrorBody(response)).toBe('rate limited ✓');
  });
});
