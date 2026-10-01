// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'bun:test';
import { classifyGeminiError } from '../../src/services/worker/GeminiProvider.js';

// From #4147: outside the regions Google serves, every Gemini request answers
// "User location is not supported". It used to read as a malformed request
// (400: the batch dropped, every batch after it too) or a refused key (403).

const regionBody = (status: number) => JSON.stringify({
  error: { code: status, message: 'User location is not supported for the API use.', status: status === 400 ? 'FAILED_PRECONDITION' : 'PERMISSION_DENIED' },
});

describe('Gemini region restriction', () => {
  for (const status of [400, 403]) {
    it(`pauses with buffered work kept and says what to change (${status})`, () => {
      const err = classifyGeminiError({ status, bodyText: regionBody(status), cause: new Error(String(status)) });
      expect(err.kind).toBe('auth_invalid');
      expect(err.code).toBe('location_unsupported');
      expect(err.message).toContain('not available in this region');
      expect(err.action).toContain('CLAUDE_MEM_PROVIDER');
    });
  }

  it('leaves other 400s and 403s as they were', () => {
    expect(classifyGeminiError({ status: 403, bodyText: 'API key not valid', cause: new Error('403') }).code).toBeUndefined();
    expect(classifyGeminiError({ status: 400, bodyText: 'Invalid JSON payload', cause: new Error('400') }).kind).toBe('unrecoverable');
  });
});
