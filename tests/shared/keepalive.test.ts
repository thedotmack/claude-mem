import { describe, it, expect } from 'bun:test';
import { parseKeepaliveIntervalMs } from '../../src/shared/keepalive.js';

describe('parseKeepaliveIntervalMs (#4159)', () => {
  it('reads a complete positive integer as enabled', () => {
    expect(parseKeepaliveIntervalMs('5000')).toBe(5000);
    expect(parseKeepaliveIntervalMs(' 5000 ')).toBe(5000);
  });

  it('treats the off value and non-positive values as disabled', () => {
    expect(parseKeepaliveIntervalMs('0')).toBe(0);
    expect(parseKeepaliveIntervalMs('')).toBe(0);
    expect(parseKeepaliveIntervalMs('-5')).toBe(0);
  });

  it('rejects malformed values instead of coercing them like parseInt', () => {
    // parseInt would read each of these as 5000 and re-enable the off switch.
    expect(parseKeepaliveIntervalMs('5000ms')).toBe(0);
    expect(parseKeepaliveIntervalMs('5000.0')).toBe(0);
    expect(parseKeepaliveIntervalMs([5000] as unknown)).toBe(0);
    expect(parseKeepaliveIntervalMs(5000 as unknown)).toBe(0);
    expect(parseKeepaliveIntervalMs(null)).toBe(0);
    expect(parseKeepaliveIntervalMs(undefined)).toBe(0);
  });
});
