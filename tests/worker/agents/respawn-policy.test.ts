// tests/worker/agents/respawn-policy.test.ts
import { describe, it, expect } from 'bun:test';
import {
  parseRespawnPolicy,
  isExemptableClass,
  evaluateRespawn,
  freshWindow,
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
    // Both dropped, for different reasons: 'xml' is a valid ObserverOutputClass
    // but not in EXEMPTABLE_CLASSES; 'nonsense' is not a class at all.
    expect([...p.exemptClasses]).toEqual(['idle']);
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

describe('evaluateRespawn', () => {
  const policy = parseRespawnPolicy('idle', '3', '60000'); // exempt idle, threshold 3, 60s

  it('treats exempt idle as invisible (no count, no respawn)', () => {
    let w = freshWindow();
    for (let i = 0; i < 10; i++) {
      const r = evaluateRespawn('idle', w, policy, 1000 + i);
      expect(r.shouldRespawn).toBe(false);
      w = r.window;
    }
    expect(w.badCount).toBe(0);
  });

  it('respawns immediately on poisoned regardless of window', () => {
    const r = evaluateRespawn('poisoned', freshWindow(), policy, 1000);
    expect(r.shouldRespawn).toBe(true);
    expect(r.window.badCount).toBe(0);
  });

  it('respawns when threshold non-exempt outputs land within the window', () => {
    let w = freshWindow();
    let r = evaluateRespawn('prose', w, policy, 1000); w = r.window; expect(r.shouldRespawn).toBe(false);
    r = evaluateRespawn('prose', w, policy, 2000); w = r.window; expect(r.shouldRespawn).toBe(false);
    expect(w.badCount).toBe(2);
    r = evaluateRespawn('prose', w, policy, 3000);
    expect(r.shouldRespawn).toBe(true);
    expect(r.window.badCount).toBe(0); // reset after respawn
  });

  it('decays: bad outputs spread beyond the window do not accumulate', () => {
    let w = freshWindow();
    let r = evaluateRespawn('prose', w, policy, 1000); w = r.window;
    r = evaluateRespawn('prose', w, policy, 2000); w = r.window;
    expect(w.badCount).toBe(2);
    // next prose arrives AFTER the 60s window from windowStart(=1000) → fresh window
    r = evaluateRespawn('prose', w, policy, 1000 + 60001);
    expect(r.shouldRespawn).toBe(false);
    expect(r.window.badCount).toBe(1);
  });

  it('interleaved exempt idle is neutral (does not advance or reset the prose streak)', () => {
    let w = freshWindow();
    let r = evaluateRespawn('prose', w, policy, 1000); w = r.window;        // 1
    r = evaluateRespawn('idle', w, policy, 1500); w = r.window;             // neutral
    expect(w.badCount).toBe(1);
    r = evaluateRespawn('prose', w, policy, 2000); w = r.window;            // 2
    r = evaluateRespawn('prose', w, policy, 2500);                          // 3 → respawn
    expect(r.shouldRespawn).toBe(true);
  });

  // ---- corner cases (public project: cover the decision surface) ----

  it('counts an xml-tagged-but-unparseable output — xml is never exemptable', () => {
    // On the invalid path the classifier can return 'xml' for a malformed block;
    // it must still count toward respawn (preserves prior recovery behavior).
    let w = freshWindow();
    let r = evaluateRespawn('xml', w, policy, 1000); w = r.window;
    r = evaluateRespawn('xml', w, policy, 2000); w = r.window;
    expect(w.badCount).toBe(2);
    r = evaluateRespawn('xml', w, policy, 3000);
    expect(r.shouldRespawn).toBe(true);
  });

  it('respawns on the first non-exempt output when threshold is 1', () => {
    const p1 = parseRespawnPolicy('idle', '1', '60000');
    expect(evaluateRespawn('prose', freshWindow(), p1, 1000).shouldRespawn).toBe(true);
  });

  it('with idle+prose both exempt, only poisoned respawns', () => {
    const pBoth = parseRespawnPolicy('idle,prose', '3', '60000');
    let w = freshWindow();
    for (let i = 0; i < 10; i++) {
      const r = evaluateRespawn(i % 2 ? 'prose' : 'idle', w, pBoth, 1000 + i);
      expect(r.shouldRespawn).toBe(false);
      w = r.window;
    }
    expect(w.badCount).toBe(0);
    expect(evaluateRespawn('poisoned', w, pBoth, 5000).shouldRespawn).toBe(true);
  });

  it('treats an output exactly at the window boundary as still inside (strict >)', () => {
    let w = freshWindow();
    let r = evaluateRespawn('prose', w, policy, 1000); w = r.window;        // windowStart=1000, count 1
    r = evaluateRespawn('prose', w, policy, 1000 + 60000); w = r.window;    // delta === windowMs → NOT expired → count 2
    expect(w.badCount).toBe(2);
  });

  it('exempt idle does not reset an already-accumulated badCount', () => {
    let w = freshWindow();
    let r = evaluateRespawn('prose', w, policy, 1000); w = r.window;        // 1
    r = evaluateRespawn('prose', w, policy, 1200); w = r.window;            // 2
    r = evaluateRespawn('idle', w, policy, 1300); w = r.window;             // neutral
    expect(w.badCount).toBe(2);
  });

  it('starts a clean window after a respawn fires', () => {
    const p2 = parseRespawnPolicy('idle', '2', '60000');
    let w = freshWindow();
    let r = evaluateRespawn('prose', w, p2, 1000); w = r.window;            // 1
    r = evaluateRespawn('prose', w, p2, 1100);                              // 2 → respawn + reset
    expect(r.shouldRespawn).toBe(true);
    expect(r.window.badCount).toBe(0);
    r = evaluateRespawn('prose', r.window, p2, 1200);                       // fresh window → 1
    expect(r.shouldRespawn).toBe(false);
    expect(r.window.badCount).toBe(1);
  });
});
