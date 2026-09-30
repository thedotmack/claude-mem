// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'bun:test';
import { normalizeRuntimeFlag } from '../../src/npx-cli/commands/server-runtime-setup.js';

describe('server-runtime-setup — install planning (#2543)', () => {
  it('normalizeRuntimeFlag accepts worker/server/server-beta and the default', () => {
    expect(normalizeRuntimeFlag(undefined)).toBe('worker');
    expect(normalizeRuntimeFlag('')).toBe('worker');
    expect(normalizeRuntimeFlag('worker')).toBe('worker');
    expect(normalizeRuntimeFlag('server')).toBe('server');
    // Phase 1d: legacy literal accepted, normalized to canonical 'server'.
    expect(normalizeRuntimeFlag('server-beta')).toBe('server');
    expect(normalizeRuntimeFlag('SERVER')).toBe('server');
    expect(normalizeRuntimeFlag('bogus')).toBeNull();
  });
});
