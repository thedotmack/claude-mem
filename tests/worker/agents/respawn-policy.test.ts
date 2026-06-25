// tests/worker/agents/respawn-policy.test.ts
import { describe, it, expect } from 'bun:test';
import {
  parseRespawnPolicy,
  isExemptableClass,
  DEFAULT_RESPAWN_THRESHOLD,
  DEFAULT_RESPAWN_WINDOW_MS,
} from '../../../src/services/worker/agents/respawn-policy.js';

describe('isExemptableClass', () => {
  it('accepts idle/prose and rejects xml/poisoned/garbage', () => {
    expect(isExemptableClass('idle')).toBe(true);
    expect(isExemptableClass('prose')).toBe(true);
    expect(isExemptableClass('xml')).toBe(false);
    expect(isExemptableClass('poisoned')).toBe(false);
    expect(isExemptableClass('nonsense')).toBe(false);
  });
});

describe('parseRespawnPolicy', () => {
  it('parses valid values', () => {
    const p = parseRespawnPolicy('idle,prose', '5', '90000');
    expect([...p.exemptClasses].sort()).toEqual(['idle', 'prose']);
    expect(p.threshold).toBe(5);
    expect(p.windowMs).toBe(90000);
  });

  it('drops unknown class tokens but keeps valid ones', () => {
    const p = parseRespawnPolicy('idle, nonsense ,xml', '3', '60000');
    expect([...p.exemptClasses]).toEqual(['idle']); // 'xml' not exemptable, 'nonsense' unknown
  });

  it('falls back to default exempt set when empty/all-invalid', () => {
    const p = parseRespawnPolicy('', '3', '60000');
    expect([...p.exemptClasses]).toEqual(['idle']);
    const p2 = parseRespawnPolicy('xml,bogus', '3', '60000');
    expect([...p2.exemptClasses]).toEqual(['idle']);
  });

  it('falls back to default threshold/window on non-numeric or out-of-range', () => {
    expect(parseRespawnPolicy('idle', 'abc', '60000').threshold).toBe(DEFAULT_RESPAWN_THRESHOLD);
    expect(parseRespawnPolicy('idle', '0', '60000').threshold).toBe(DEFAULT_RESPAWN_THRESHOLD);   // < min 1
    expect(parseRespawnPolicy('idle', '101', '60000').threshold).toBe(DEFAULT_RESPAWN_THRESHOLD); // > max 100
    expect(parseRespawnPolicy('idle', '3', '500').windowMs).toBe(DEFAULT_RESPAWN_WINDOW_MS);      // < min 1000
    expect(parseRespawnPolicy('idle', '3', 'nope').windowMs).toBe(DEFAULT_RESPAWN_WINDOW_MS);
  });

  // ---- corner cases (public project: cover the parse surface) ----

  it('trims surrounding whitespace and dedupes class tokens', () => {
    const p = parseRespawnPolicy('  idle , prose , idle ', '3', '60000');
    expect([...p.exemptClasses].sort()).toEqual(['idle', 'prose']);
  });

  it('ignores empty segments from stray/leading/trailing commas', () => {
    expect([...parseRespawnPolicy('idle,,', '3', '60000').exemptClasses]).toEqual(['idle']);
    expect([...parseRespawnPolicy(',prose,', '3', '60000').exemptClasses]).toEqual(['prose']);
  });

  it('is case-sensitive: a mis-cased class is rejected and the set falls back to default', () => {
    // Matches the canonical lowercase ObserverOutputClass literals; the unknown
    // token is warned + dropped, leaving an empty set -> default {idle}.
    expect([...parseRespawnPolicy('IDLE', '3', '60000').exemptClasses]).toEqual(['idle']);
    expect([...parseRespawnPolicy('Prose', '3', '60000').exemptClasses]).toEqual(['idle']);
  });

  it('accepts threshold and window at the inclusive bounds', () => {
    expect(parseRespawnPolicy('idle', '1', '1000').threshold).toBe(1);
    expect(parseRespawnPolicy('idle', '100', '3600000').threshold).toBe(100);
    expect(parseRespawnPolicy('idle', '1', '1000').windowMs).toBe(1000);
    expect(parseRespawnPolicy('idle', '100', '3600000').windowMs).toBe(3600000);
  });

  it('rejects values one step outside the bounds', () => {
    expect(parseRespawnPolicy('idle', '101', '60000').threshold).toBe(DEFAULT_RESPAWN_THRESHOLD);
    expect(parseRespawnPolicy('idle', '3', '999').windowMs).toBe(DEFAULT_RESPAWN_WINDOW_MS);
    expect(parseRespawnPolicy('idle', '3', '3600001').windowMs).toBe(DEFAULT_RESPAWN_WINDOW_MS);
  });

  it('rejects negative and empty-string numeric inputs', () => {
    expect(parseRespawnPolicy('idle', '-5', '60000').threshold).toBe(DEFAULT_RESPAWN_THRESHOLD);
    expect(parseRespawnPolicy('idle', '', '60000').threshold).toBe(DEFAULT_RESPAWN_THRESHOLD);
    expect(parseRespawnPolicy('idle', '3', '').windowMs).toBe(DEFAULT_RESPAWN_WINDOW_MS);
  });

  it('parseInt-truncates a decimal threshold within bounds (documented; matches parseBoundedTimeout)', () => {
    // parseInt('3.9', 10) === 3; in-bounds -> accepted as 3. Pinned so the
    // behavior is intentional, not accidental.
    expect(parseRespawnPolicy('idle', '3.9', '60000').threshold).toBe(3);
  });
});
