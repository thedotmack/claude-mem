import { describe, expect, it } from 'bun:test';
import { randomUUID } from 'crypto';
import {
  armOpensBrowser,
  armShowsReminder,
  deferredSourceForArm,
  signinArmForInstallId,
} from '../../src/npx-cli/install/signin-arm';

describe('signinArmForInstallId', () => {
  it('always gives the same arm for a fixed install id', () => {
    const id = '3f9d7c1e-2b4a-4e8f-9a61-0c5d2e7b8a90';
    const first = signinArmForInstallId(id);
    for (let i = 0; i < 20; i++) expect(signinArmForInstallId(id)).toBe(first);
  });

  it('splits 10k random ids roughly evenly across A/B/C', () => {
    const counts = { A: 0, B: 0, C: 0 };
    for (let i = 0; i < 10_000; i++) counts[signinArmForInstallId(randomUUID())]++;
    for (const arm of ['A', 'B', 'C'] as const) {
      // 1/3 each, within ±3 points (the binomial sd here is ~0.5 points).
      expect(counts[arm]).toBeGreaterThan(3033);
      expect(counts[arm]).toBeLessThan(3633);
    }
  });

  it('maps arms to behavior and pairing source', () => {
    expect(armOpensBrowser('A')).toBe(false);
    expect(armOpensBrowser('B')).toBe(true);
    expect(armOpensBrowser('C')).toBe(true);
    expect(armShowsReminder('A')).toBe(false);
    expect(armShowsReminder('B')).toBe(false);
    expect(armShowsReminder('C')).toBe(true);
    expect(deferredSourceForArm('A')).toBe('npx-installer-deferred');
    expect(deferredSourceForArm('B')).toBe('npx-installer-deferred-open');
    expect(deferredSourceForArm('C')).toBe('npx-installer-deferred-open');
  });
});
