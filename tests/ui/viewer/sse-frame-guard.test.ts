import { describe, expect, it } from 'bun:test';
import { parseStreamFrame } from '../../../src/ui/viewer/hooks/useSSE.js';

/**
 * `onmessage` is an async browser callback, so a throw inside it is not caught
 * by the React error boundary that wraps the app. Every producer on the stream
 * writes `data: ${JSON.stringify(...)}` today, so a non-JSON frame only becomes
 * reachable through a future producer or a rewriting proxy — the handler must
 * still drop it instead of letting the bad frame raise an uncaught error.
 */
describe('parseStreamFrame', () => {
  it('returns the event for a well-formed frame', () => {
    const frame = parseStreamFrame(JSON.stringify({ type: 'processing_status', isProcessing: true, queueDepth: 7 }));
    expect(frame).toEqual({ type: 'processing_status', isProcessing: true, queueDepth: 7 });
  });

  for (const [label, raw] of [
    ['an HTML error page', '<html>proxy error</html>'],
    ['a truncated object', '{"type":"new_observation"'],
    ['empty data', ''],
    ['JSON null', 'null'],
    ['a JSON string', '"just a string"'],
    ['a JSON number', '42'],
    ['a JSON array', '[{"type":"initial_load"}]'],
  ] as const) {
    it(`returns null for ${label}`, () => {
      expect(() => parseStreamFrame(raw)).not.toThrow();
      expect(parseStreamFrame(raw)).toBeNull();
    });
  }

  it('keeps accepting valid frames after a rejected one', () => {
    expect(parseStreamFrame('not json at all')).toBeNull();
    expect(parseStreamFrame(JSON.stringify({ type: 'connected' }))).toEqual({ type: 'connected' });
  });
});
