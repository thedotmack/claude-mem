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

  it('keeps image metadata that has a URL but no binary payload', () => {
    const result = { type: 'image', url: 'https://example.test/screenshot.png' };
    expect(stripImageContent(result)).toEqual(result);
  });

  it('keeps URL-backed image sources while removing base64 sources', () => {
    const result = stripImageContent([
      { type: 'image', source: { type: 'url', data: 'https://example.test/image.png' } },
      { type: 'image', source: { type: 'base64', data: 'base64-image' } },
    ]);

    expect(result).toEqual([
      { type: 'image', source: { type: 'url', data: 'https://example.test/image.png' } },
    ]);
  });

  it('leaves non-plain objects intact', () => {
    const date = new Date('2026-01-01T00:00:00.000Z');
    expect(stripImageContent(date)).toBe(date);
  });

  it('removes image blocks backed by Buffer or typed-array data', () => {
    const result = stripImageContent([
      { type: 'image', data: Buffer.from([0xff, 0xd8, 0xff]) },
      { type: 'image', source: { type: 'base64', data: new Uint8Array([0xff, 0xd9]) } },
      { type: 'text', text: 'kept' },
    ]);

    expect(result).toEqual([{ type: 'text', text: 'kept' }]);
  });

  it('does not remove image-looking class instances', () => {
    class ImageMetadata {
      type = 'image';
      data = 'https://example.test/image.png';
    }

    const metadata = new ImageMetadata();
    expect(stripImageContent(metadata)).toBe(metadata);
  });
});
