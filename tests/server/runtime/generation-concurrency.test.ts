import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';

import { resolveServerGenerationConcurrency } from '../../../src/server/runtime/ActiveServerQueueManager.js';
import { logger } from '../../../src/utils/logger.js';

/**
 * Coverage for CLAUDE_MEM_SERVER_GENERATION_CONCURRENCY.
 *
 * ServerJobQueue defaults to `concurrency: 1` and buildQueues passed no value, so
 * generation was serial regardless of deployment. That is fine until the estate
 * produces events faster than one worker retires them, at which point nothing
 * fails: jobs still complete, health checks still pass, and observations simply
 * arrive hours after the work they describe.
 *
 * Unset must keep the old behaviour, so the default path is asserted too.
 */
describe('resolveServerGenerationConcurrency', () => {
  const KEY = 'CLAUDE_MEM_SERVER_GENERATION_CONCURRENCY';
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env[KEY];
    delete process.env[KEY];
  });

  afterEach(() => {
    if (previous === undefined) delete process.env[KEY];
    else process.env[KEY] = previous;
  });

  it('returns undefined when unset, so the queue keeps its default of 1', () => {
    expect(resolveServerGenerationConcurrency()).toBeUndefined();
  });

  it('returns the configured value', () => {
    process.env[KEY] = '6';
    expect(resolveServerGenerationConcurrency()).toBe(6);
  });

  for (const bad of ['0', '-4', '2.5', 'many', '']) {
    it(`ignores ${JSON.stringify(bad)} rather than starting a broken worker`, () => {
      process.env[KEY] = bad;
      const warn = spyOn(logger, 'warn').mockImplementation(() => undefined);
      try {
        expect(resolveServerGenerationConcurrency()).toBeUndefined();
      } finally {
        warn.mockRestore();
      }
    });
  }

  it('warns on a value it refuses, so a typo is not silently serial', () => {
    process.env[KEY] = 'six';
    const warn = spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      resolveServerGenerationConcurrency();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
