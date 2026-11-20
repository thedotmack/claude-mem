import { describe, it } from 'bun:test';
import { assertContextReadResponsive } from '../helpers/context-read-http-probe.js';

describe('HTTP responsiveness during a blocked context read', () => {
  it('keeps health responsive and returns context after the database unlocks', async () => {
    await assertContextReadResponsive();
  }, 20_000);
});
