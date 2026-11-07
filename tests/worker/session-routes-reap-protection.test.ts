import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { recordQuotaExhausted, resetQuotaCooldownsForTesting } from '../../src/shared/quota-cooldown.js';

// Imported lazily so the quota-cooldown module loads with the routes module.
const { SessionRoutes } = await import('../../src/services/worker/http/routes/SessionRoutes.js');

const cooldownState = await import('../../src/shared/quota-cooldown.js');

/**
 * A newly buffered session whose generator start stays refused by an active
 * provider cooldown must not be protected from the reaper forever: protecting
 * it every sweep leaves its cold buffer in the pending count for good. A
 * start admission can actually serve is protected.
 */
describe('SessionRoutes queued-start reap protection', () => {
  let routes: {
    ensureGeneratorLocks: Map<number, Promise<void>>;
    sessionManager: { getSession: (id: number) => { platformSource: string } | undefined };
    shouldProtectQueuedStart: (id: number) => boolean;
  };

  beforeEach(() => {
    cooldownState.resetQuotaCooldownsForTesting();
    routes = Object.create(SessionRoutes.prototype) as unknown as typeof routes;
    routes.ensureGeneratorLocks = new Map([[20, Promise.resolve()]]);
    routes.sessionManager = {
      // no platformSource: dispatch falls back to CLAUDE_MEM_PROVIDER (claude).
      getSession: (id: number) => (id === 20 ? { platformSource: 'claude' } : undefined),
    };
  });

  afterEach(() => {
    cooldownState.resetQuotaCooldownsForTesting();
    mock.restore();
  });

  it('does not protect a cold session whose queued start admission will refuse', () => {
    recordQuotaExhausted('claude', 'synthetic cooldown', undefined);
    expect(routes.shouldProtectQueuedStart(20)).toBe(false);
  });

  it('protects a queued start once admission can serve it', () => {
    expect(routes.shouldProtectQueuedStart(20)).toBe(true);
    recordQuotaExhausted('claude', 'synthetic cooldown', undefined);
    expect(routes.shouldProtectQueuedStart(20)).toBe(false);
  });

  it('does not protect a session without a queued start', () => {
    expect(routes.shouldProtectQueuedStart(21)).toBe(false);
  });
});
