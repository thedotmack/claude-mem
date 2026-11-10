import { describe, expect, it } from 'bun:test';
import { readCappedErrorBody } from '../../src/shared/capped-error-body.js';

describe('readCappedErrorBody reader ownership', () => {

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
