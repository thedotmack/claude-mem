import { describe, it, expect } from 'bun:test';
import {
  PROMPT_TEXT_MAX_BYTES,
  PROMPT_TRUNCATION_MARKER,
  clampPromptTextForSync,
} from '../../../src/services/sync/prompt-text-clamp.js';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const jsonBytes = (text: string): number => Buffer.byteLength(JSON.stringify(text), 'utf8') - 2;

describe('clampPromptTextForSync', () => {
  it('passes a prompt that fits through unchanged, and null as null', () => {
    expect(clampPromptTextForSync('hello', null)).toBe('hello');
    expect(clampPromptTextForSync(null, null)).toBeNull();
  });

  it('drops a multibyte character the byte cut split in two', () => {
    // 'ab☃' is 5 bytes; cut after 4 the snowman is incomplete.
    const head = encode('ab☃').subarray(0, 4);
    expect(clampPromptTextForSync(null, head)).toBe(`ab${PROMPT_TRUNCATION_MARKER}`);
  });

  it('drops a four-byte character cut anywhere inside it', () => {
    const bytes = encode('a😀');
    for (const cut of [2, 3, 4]) {
      expect(clampPromptTextForSync(null, bytes.subarray(0, cut))).toBe(`a${PROMPT_TRUNCATION_MARKER}`);
    }
    expect(clampPromptTextForSync(null, bytes)).toBe(`a😀${PROMPT_TRUNCATION_MARKER}`);
  });

  it('never leaves half of a surrogate pair at the cut', () => {
    const text = '😀'.repeat(PROMPT_TEXT_MAX_BYTES);
    const clamped = clampPromptTextForSync(text, null)!;
    const kept = clamped.slice(0, -PROMPT_TRUNCATION_MARKER.length);
    expect(kept).toBe('😀'.repeat(kept.length / 2));
    expect(jsonBytes(clamped)).toBeLessThanOrEqual(PROMPT_TEXT_MAX_BYTES);
  });

  it('keeps an oversized head within the bound once escaped', () => {
    const head = encode('\\'.repeat(PROMPT_TEXT_MAX_BYTES));
    const clamped = clampPromptTextForSync(null, head)!;
    expect(clamped.endsWith(PROMPT_TRUNCATION_MARKER)).toBe(true);
    expect(jsonBytes(clamped)).toBeLessThanOrEqual(PROMPT_TEXT_MAX_BYTES);
    expect(jsonBytes(clamped)).toBeGreaterThan(PROMPT_TEXT_MAX_BYTES - 200);
  });
});
