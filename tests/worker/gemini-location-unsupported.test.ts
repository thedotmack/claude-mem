// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it } from 'bun:test';
import { classifyGeminiError } from '../../src/services/worker/GeminiProvider.js';
import { keyCooldownRemainingMs, resetKeyPoolStateForTesting, withKeyPool } from '../../src/shared/api-key-pool.js';

// From #4147: outside the regions Google serves, every Gemini request answers
// "User location is not supported". It used to read as a malformed request
// (400: the batch dropped, every batch after it too) or a refused key (403).

const regionBody = (status: number) => JSON.stringify({
  error: { code: status, message: 'User location is not supported for the API use.', status: status === 400 ? 'FAILED_PRECONDITION' : 'PERMISSION_DENIED' },
});

describe('Gemini region restriction', () => {
  beforeEach(() => {
    resetKeyPoolStateForTesting();
  });

  for (const status of [400, 403]) {
    it(`pauses with buffered work kept and says what to change (${status})`, () => {
      const err = classifyGeminiError({ status, bodyText: regionBody(status), cause: new Error(String(status)) });
      // auth_invalid is a pause that keeps the batch (preservingAbortReason)
      // and holds Gemini for one cooldown; unrecoverable would drop it.
      expect(err.kind).toBe('auth_invalid');
      expect(err.code).toBe('location_unsupported');
      expect(err.message).toContain('not available in this region');
      expect(err.action).toContain('CLAUDE_MEM_PROVIDER');
    });

    it(`sends one request and parks no key of a multi-key pool (${status})`, async () => {
      // Every key gets the same answer: the region, not the key, is refused.
      // Rotating would send a doomed request per key and park each for the
      // 6-hour refused-key window, long after the region problem is fixed.
      const keys = ['AIza-one', 'AIza-two', 'AIza-three'];
      const sent: string[] = [];
      await expect(withKeyPool({ poolId: 'gemini', keys, label: 'Gemini' }, async ({ key }) => {
        sent.push(key);
        throw classifyGeminiError({ status, bodyText: regionBody(status), cause: new Error(String(status)) });
      })).rejects.toMatchObject({ kind: 'auth_invalid', code: 'location_unsupported' });

      expect(sent).toEqual(['AIza-one']);
      for (const key of keys) expect(keyCooldownRemainingMs('gemini', key)).toBe(0);
    });
  }

  it('leaves other 400s and 403s as they were', () => {
    expect(classifyGeminiError({ status: 403, bodyText: 'API key not valid', cause: new Error('403') }).code).toBeUndefined();
    expect(classifyGeminiError({ status: 400, bodyText: 'Invalid JSON payload', cause: new Error('400') }).kind).toBe('unrecoverable');
  });
});
