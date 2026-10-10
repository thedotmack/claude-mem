import { describe, expect, it } from 'bun:test';
import { readCappedErrorBody } from '../../src/shared/capped-error-body.js';

describe('readCappedErrorBody reader lifetime', () => {
  it('releases a normally exhausted response body', async () => {
    const response = new Response('provider error');
    expect(await readCappedErrorBody(response)).toBe('provider error');
    expect(response.body!.locked).toBe(false);
  });

  it('cancels a capped body and releases its reader', async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('abcdef')); },
      cancel() { cancelled = true; },
    }));
    expect(await readCappedErrorBody(response, 3)).toBe('abc');
    expect(cancelled).toBe(true);
    expect(response.body!.locked).toBe(false);
  });

  it('releases its reader when reading fails', async () => {
    const failure = new Error('body read failed');
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.error(failure); },
    }));
    await expect(readCappedErrorBody(response)).rejects.toBe(failure);
    expect(response.body!.locked).toBe(false);
  });
});
