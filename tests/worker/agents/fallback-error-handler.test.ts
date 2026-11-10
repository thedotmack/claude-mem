import { describe, it, expect } from 'bun:test';

import { isAbortError } from '../../../src/services/worker/agents/FallbackErrorHandler.js';

describe('FallbackErrorHandler', () => {
  it('distinguishes aborts from other failures', () => {
    for (const error of [
      Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }),
      { name: 'AbortError', message: 'aborted' },
    ]) expect(isAbortError(error)).toBe(true);
    for (const error of [
      new Error('Some error'), new TypeError('Type error'),
      Object.assign(new Error('timeout'), { name: 'TimeoutError' }),
      null, undefined, 'AbortError', { message: 'error' }, {},
    ]) expect(isAbortError(error)).toBe(false);
  });
});
