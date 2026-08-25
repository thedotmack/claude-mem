import { describe, expect, it } from 'bun:test';
import { stripImageContent } from '../../../src/services/worker/http/shared.js';

describe('stripImageContent', () => {
  it('removes image content blocks while preserving text blocks', () => {
    const result = stripImageContent([
      { type: 'text', text: 'The page loaded' },
      { type: 'image', source: { type: 'base64', data: 'very-large-payload' }, mimeType: 'image/png' },
      { type: 'text', text: 'The button is visible' },
    ]);

    expect(result).toEqual([
      { type: 'text', text: 'The page loaded' },
      { type: 'text', text: 'The button is visible' },
    ]);
  });

  it('removes nested image blocks from otherwise useful tool results', () => {
    const result = stripImageContent({
      content: [
        { type: 'text', text: 'done' },
        { type: 'image', data: 'base64-image' },
      ],
      metadata: { screenshot: { type: 'image', data: 'nested-image' }, status: 'ok' },
    });

    expect(result).toEqual({
      content: [{ type: 'text', text: 'done' }],
      metadata: { status: 'ok' },
    });
  });

  it('leaves ordinary tool results unchanged', () => {
    const result = { text: 'plain output', exitCode: 0, items: ['a', 'b'] };
    expect(stripImageContent(result)).toEqual(result);
  });

  it('removes a result containing only an image', () => {
    expect(JSON.stringify(stripImageContent({ type: 'image', data: 'base64-image' }))).toBeUndefined();
  });
});
