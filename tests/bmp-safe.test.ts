import { describe, it, expect } from 'bun:test';
import { toBmpSafe, hasAstral } from '../src/utils/bmp-safe';

function hasSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdfff) return true;
  }
  return false;
}

describe('toBmpSafe (issue #2787)', () => {
  it('maps known astral type markers to distinct BMP glyphs', () => {
    expect(toBmpSafe('🔴')).toBe('●');
    expect(toBmpSafe('🟣')).toBe('◆');
    expect(toBmpSafe('🔄')).toBe('↻');
    expect(toBmpSafe('🔵')).toBe('○');
    expect(toBmpSafe('🚨')).toBe('⚠');
    expect(toBmpSafe('🔐')).toBe('⚷');
  });

  it('degrades unknown astral code points to a BMP bullet', () => {
    expect(toBmpSafe('🦄')).toBe('•');
    expect(toBmpSafe('𐍈')).toBe('•'); // Gothic letter, non-emoji astral
  });

  it('leaves BMP text untouched', () => {
    const s = 'Recent Activity ● bugfix — fixed the worker (no surrogates here) ✓ ⚖';
    expect(toBmpSafe(s)).toBe(s);
  });

  it('output never contains a UTF-16 surrogate code unit', () => {
    const messy = '🔴 a 🟣 b 🔄 c 🦄 d 🎯 e 💬 f ✅ g ⚖️ h 🧠';
    const safe = toBmpSafe(messy);
    expect(hasSurrogate(safe)).toBe(false);
    expect(hasAstral(safe)).toBe(false);
  });

  it('drops pre-existing lone surrogates', () => {
    const loneHigh = '\uD83D'; // high surrogate with no pair
    expect(toBmpSafe(`x${loneHigh}y`)).toBe('xy');
  });

  it('handles empty and falsy input', () => {
    expect(toBmpSafe('')).toBe('');
  });
});
