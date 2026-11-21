import { describe, expect, it } from 'bun:test';
import { standaloneObserverRegistrySessionId } from '../src/services/worker/ClaudeProvider.js';

/**
 * Field compression and the Telegram wrap-up spawn their own SDK child while
 * the session's generation may still be running. Those children must be
 * visible to the worker's shutdown cascade (they were not: the standalone
 * call passed no spawn factory at all), but they must also never collide with
 * the generation's own SDK process for the same session — the factory's
 * duplicate handling SIGTERMs same-key SDK records, and that generation
 * process is alive mid-turn. So the standalone child is registered under the
 * session's negated id, which no real session can occupy, and takes no
 * concurrency slot (one bounded SDK turn, gated by its own abort deadline).
 */
describe('standalone observer spawn registration', () => {
  it('keys the standalone child under the negated session id', () => {
    expect(standaloneObserverRegistrySessionId(42)).toBe(-42);
  });

  it('never collides with a real (positive) session id', () => {
    for (const id of [1, 7, 4096]) {
      const key = standaloneObserverRegistrySessionId(id);
      expect(key).toBeLessThan(0);
      expect(key).not.toBe(id);
    }
    // Already-negative ids stay themselves, so repeated standalone calls for
    // the same session still replace each other instead of piling up.
    expect(standaloneObserverRegistrySessionId(-7)).toBe(-7);
  });
});
