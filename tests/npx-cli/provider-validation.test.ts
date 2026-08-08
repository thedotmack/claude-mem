// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'bun:test';
import { isKnownProvider } from '../../src/npx-cli/commands/install.js';

describe('isKnownProvider', () => {
  it('accepts every provider the worker understands', () => {
    expect(isKnownProvider('claude')).toBe(true);
    expect(isKnownProvider('gemini')).toBe(true);
    expect(isKnownProvider('openrouter')).toBe(true);
  });

  // `cmem` is a prompt-only sentinel — picking it persists 'openrouter', so it
  // must never be treated as a stored provider.
  it('rejects the cmem prompt sentinel', () => {
    expect(isKnownProvider('cmem')).toBe(false);
  });

  // Regression: `loadFromFile` merges defaults but never validates them, so a
  // hand-edited settings.json can hand back anything. An emptiness check let a
  // malformed provider ride through `update` and the non-TTY promptProvider
  // fallback as though it were selected.
  it('rejects hand-edited and corrupt values', () => {
    expect(isKnownProvider('malformed-provider')).toBe(false);
    expect(isKnownProvider('Claude')).toBe(false);
    expect(isKnownProvider(' claude ')).toBe(false);
    expect(isKnownProvider('')).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(isKnownProvider(undefined)).toBe(false);
    expect(isKnownProvider(null)).toBe(false);
    expect(isKnownProvider(42)).toBe(false);
    expect(isKnownProvider({ provider: 'claude' })).toBe(false);
  });
});
