import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { detectOutputMode } from '../src/output.ts';

// ─── detectOutputMode ─────────────────────────────────────────────────────
//
// Logic under test:
//   if (options.json) return 'agent';
//   if (!process.stdout.isTTY) return 'agent';
//   return 'human';

describe('detectOutputMode', () => {
  // We need to temporarily override process.stdout.isTTY in some tests.
  // Bun runs tests in a non-TTY environment, so isTTY is typically undefined/false.

  it('returns "agent" when json flag is true, regardless of TTY', () => {
    // Force isTTY = true to show json flag wins
    const originalIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

    try {
      expect(detectOutputMode({ json: true })).toBe('agent');
    } finally {
      Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true });
    }
  });

  it('returns "agent" when json flag is true and stdout is not a TTY', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });

    try {
      expect(detectOutputMode({ json: true })).toBe('agent');
    } finally {
      Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
    }
  });

  it('returns "human" when json flag is false and stdout is a TTY', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

    try {
      expect(detectOutputMode({ json: false })).toBe('human');
    } finally {
      Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
    }
  });

  it('returns "agent" when json flag is false and stdout is not a TTY', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });

    try {
      expect(detectOutputMode({ json: false })).toBe('agent');
    } finally {
      Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
    }
  });

  it('returns "agent" when json flag is absent and stdout is not a TTY', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });

    try {
      expect(detectOutputMode({})).toBe('agent');
    } finally {
      // nothing to restore — already undefined
    }
  });

  it('returns "human" when json flag is absent and stdout is a TTY', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

    try {
      expect(detectOutputMode({})).toBe('human');
    } finally {
      Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
    }
  });
});
