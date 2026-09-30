import { describe, it, expect, mock, beforeEach, afterEach, afterAll, spyOn } from 'bun:test';
import { logger } from '../../../../src/utils/logger.js';

/**
 * #2756 adaptation: the fork this suite was ported from (v13.9.3) stubbed
 * provider selection by monkey-patching a `SessionRoutes.getSelectedProvider()`
 * INSTANCE method. That method no longer exists — provider selection has
 * since moved to the free-standing `selectProviderForGenerator()` /
 * `getSelectedProvider()` in provider-dispatch.js, which reads real
 * settings.json + keychain-backed API keys (verified empirically: bun's
 * mock.module DOES retroactively patch a module already imported elsewhere,
 * even when the mock call happens after that import has evaluated).
 * `providerSelectionBox.current` is the seam these tests use instead,
 * following the same capture-snapshot-then-mock.module pattern as
 * tests/integration/worker-api-endpoints.test.ts (bun's mock.module is
 * process-global and mock.restore() does NOT undo it, so the real module is
 * explicitly re-installed in afterAll for any later file in a full-suite run).
 */
import * as realProviderDispatch from '../../../../src/services/worker/provider-dispatch.js';
const realProviderDispatchSnapshot = { ...realProviderDispatch };

const providerSelectionBox: { current: 'claude' | 'gemini' | 'openrouter' } = { current: 'claude' };

mock.module('../../../../src/services/worker/provider-dispatch.js', () => ({
  ...realProviderDispatchSnapshot,
  selectProviderForGenerator: () => ({ provider: providerSelectionBox.current, gatewayProbeClaimId: null }),
  getSelectedProvider: () => providerSelectionBox.current,
}));

import { SessionRoutes } from '../../../../src/services/worker/http/routes/SessionRoutes.js';
import { telemetryBuffer } from '../../../../src/services/telemetry/buffer.js';
import { getProcessRegistry, waitForSlot, isSessionParkedForSlot } from '../../../../src/supervisor/process-registry.js';
import { guardSharedProcessRegistrySingleton } from '../../../supervisor/process-registry-singleton-guard.js';
import { guardSharedQuotaCooldownSingleton } from '../../../shared/quota-cooldown-singleton-guard.js';
import { clearDependencyStatus } from '../../../../src/shared/dependency-health.js';
import type { ActiveSession, ConversationMessage } from '../../../../src/services/worker-types.js';

/**
 * #2756/(b) — exercises SessionRoutes.ensureGeneratorRunning's provider-change
 * branch: a generator PARKED in the real waitForSlot (never acquired a slot)
 * must be aborted and immediately replaced by a fresh generator for the newly
 * selected provider, while a generator that already acquired its slot
 * (mid-response) must be left alone.
 *
 * Deliberately drives the REAL process-registry singleton (waitForSlot /
 * isSessionParkedForSlot) rather than mock.module-ing it: mock.module is
 * process-global in bun and would leak into every other test file in the same
 * `bun test` run unless painstakingly snapshotted/restored (see the
 * mock.module comments elsewhere in this suite). Using the real registry with
 * a fake 'sdk' occupant to force parking, and cleaning it up in afterEach,
 * gets the same isolation without that risk — see
 * tests/supervisor/process-registry.test.ts for the twin pattern, and
 * process-registry-singleton-guard.ts (installed below) for why "cleaned up
 * in afterEach" alone isn't sufficient given this singleton is also shared
 * with tests/worker/http/routes/data-routes-processing-status.test.ts,
 * tests/supervisor/process-registry.test.ts, and
 * tests/supervisor/wait-for-slot.test.ts in the same `bun test` process.
 */

let loggerSpies: ReturnType<typeof spyOn>[] = [];

function makeConversationHistory(): ConversationMessage[] {
  return [{ role: 'user', content: 'hello' }];
}

function makeFakeSession(sessionDbId: number): ActiveSession {
  return {
    sessionDbId,
    contentSessionId: `content-${sessionDbId}`,
    memorySessionId: null,
    project: 'test-project',
    platformSource: 'claude-code',
    userPrompt: 'test prompt',
    abortController: new AbortController(),
    generatorPromise: null,
    lastPromptNumber: 1,
    startTime: Date.now(),
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    earliestPendingTimestamp: null,
    claimedMessageIds: [],
    conversationHistory: makeConversationHistory(),
    currentProvider: null,
    consecutiveRestarts: 0,
    consecutiveInvalidOutputs: 0,
    consecutiveContextOverflows: 0,
    lastGeneratorActivity: Date.now(),
  };
}

function makeFakeMessageBuffer() {
  return {
    getPendingCount: mock(() => 0),
    peekTypes: mock(() => [] as Array<{ message_type: string; tool_name?: string }>),
  };
}

function makeRoutes(session: ActiveSession, agents: {
  sdkAgent: { startSession: ReturnType<typeof mock> };
  geminiAgent: { startSession: ReturnType<typeof mock> };
  openRouterAgent: { startSession: ReturnType<typeof mock> };
}) {
  const messageBuffer = makeFakeMessageBuffer();
  const sessionManager = {
    getSession: mock((id: number) => (id === session.sessionDbId ? session : undefined)),
    getMessageBuffer: mock(() => messageBuffer),
    removeSessionImmediate: mock(() => {}),
  };
  const completionHandler = {
    finalizeSession: mock(() => Promise.resolve()),
  };

  const routes = new SessionRoutes(
    sessionManager as any,
    {} as any, // dbManager — unused by ensureGeneratorRunning
    agents.sdkAgent as any,
    agents.geminiAgent as any,
    agents.openRouterAgent as any,
    {} as any, // eventBroadcaster — unused by ensureGeneratorRunning
    {} as any, // workerService
    completionHandler as any,
  );

  return { routes, sessionManager, completionHandler, messageBuffer };
}

const registry = getProcessRegistry();
const registeredIds: string[] = [];

function registerFakeOccupant(sessionId: string | number): string {
  const id = `sdk:switch-test-${sessionId}:${Math.random().toString(36).slice(2)}`;
  registry.register(id, {
    pid: process.pid,
    type: 'sdk',
    sessionId,
    startedAt: new Date().toISOString(),
  });
  registeredIds.push(id);
  return id;
}

// Registered at true file top level, OUTSIDE the describe below (and
// outside its own beforeEach/afterEach nested just inside it): bun runs
// afterEach hooks inner-scope-first, outer-scope-last (LIFO) regardless of
// source order, so this outer-scope guard is guaranteed to run its "after"
// check only once the describe's own local cleanup (registeredIds
// unregister, nested one level in) has already finished. See
// process-registry-singleton-guard.ts for why this file needs it at all.
guardSharedProcessRegistrySingleton('session-routes-provider-switch.test.ts');
// This file drives SessionRoutes.ensureGeneratorRunning -> admitAndStartGenerator
// for real, which calls the real (unmocked) tryAdmitQuotaProbe on every
// fresh-start/parked-switch path — see quota-cooldown-singleton-guard.ts for
// why that shared singleton needs the same before/after hygiene check.
guardSharedQuotaCooldownSingleton('session-routes-provider-switch.test.ts');

afterAll(() => {
  mock.module('../../../../src/services/worker/provider-dispatch.js', () => realProviderDispatchSnapshot);
});

describe('SessionRoutes.ensureGeneratorRunning — provider switch (#2756)', () => {
  // Nested one level inside the describe (deeper than the guard above) on
  // purpose — see the comment on the guard call above for why the relative
  // nesting, not just declaration order, is what keeps this cleanup
  // guaranteed to run before the guard's "after" check.
  beforeEach(() => {
    providerSelectionBox.current = 'claude';
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
      spyOn(logger, 'failure').mockImplementation(() => {}),
    ];
    clearDependencyStatus('claude_cli');
  });

  afterEach(() => {
    loggerSpies.forEach(spy => spy.mockRestore());
    clearDependencyStatus('claude_cli');
    while (registeredIds.length > 0) {
      const id = registeredIds.pop();
      if (id) registry.unregister(id);
    }
  });

  it('aborts a PARKED generator and switches immediately when the provider changes', async () => {
    const sessionDbId = 900001;
    const session = makeFakeSession(sessionDbId);

    // Force parking: one occupant fills the (limit=1) pool, so the fake
    // Claude agent's waitForSlot call below never acquires a slot until we
    // free the occupant or abort it.
    registerFakeOccupant('occupant-for-900001');

    const sdkAgent = {
      // Mirrors ClaudeProvider.startSession's real shape: await waitForSlot
      // with the session's own abortController.signal, then (never reached
      // here) go on to actually spawn. Rejects with the real waitForSlot
      // abort error once the controller aborts — exactly like production.
      startSession: mock((s: ActiveSession) => waitForSlot(1, s.abortController.signal, s.sessionDbId)),
    };
    const geminiAgent = { startSession: mock(() => Promise.resolve()) };
    // Pending, not resolved: a real generator stays running for the life of
    // the session (consuming messages) rather than settling immediately. A
    // trivially-resolved mock would make the chain's own .finally() fire
    // right away and finalize/remove the session — masking the very
    // provider-switch behavior this test exists to verify.
    const openRouterAgent = { startSession: mock(() => new Promise<void>(() => {})) };

    const { routes, sessionManager, completionHandler } = makeRoutes(session, { sdkAgent, geminiAgent, openRouterAgent });

    // First call: starts the Claude generator, which immediately parks.
    await routes.ensureGeneratorRunning(sessionDbId, 'init');

    expect(sdkAgent.startSession).toHaveBeenCalledTimes(1);
    expect(session.currentProvider).toBe('claude');
    expect(session.generatorPromise).not.toBeNull();
    expect(isSessionParkedForSlot(sessionDbId)).toBe(true);

    const originalAbortController = session.abortController;
    const originalConversationHistory = session.conversationHistory;
    const originalClaimedMessageIds = session.claimedMessageIds;

    // #2756 round-2 review finding (important): normalizeAbortReason's new
    // 'provider_switch' case is the only thing standing between this abort
    // and a silently corrupted session_compressed telemetry event (a typo'd
    // case falls through to the 'none' default with no type error and no
    // other test noticing). Spy on the real telemetryBuffer.record and
    // assert the emitted abort_reason directly, rather than only asserting
    // on session state.
    const telemetrySpy = spyOn(telemetryBuffer, 'record');

    // Settings changed: openrouter is now selected.
    providerSelectionBox.current = 'openrouter';
    await routes.ensureGeneratorRunning(sessionDbId, 'ingest');

    const abortedTelemetryCall = telemetrySpy.mock.calls.find(
      ([event, id]) => event === 'session_compressed' && id === sessionDbId
    );
    expect(abortedTelemetryCall).toBeDefined();
    expect((abortedTelemetryCall?.[2] as Record<string, unknown> | undefined)?.abort_reason).toBe('provider_switch');
    telemetrySpy.mockRestore();

    // Parked wait was aborted and replaced.
    expect(originalAbortController.signal.aborted).toBe(true);
    expect(isSessionParkedForSlot(sessionDbId)).toBe(false);
    expect(openRouterAgent.startSession).toHaveBeenCalledTimes(1);
    expect(session.currentProvider).toBe('openrouter');
    expect(session.generatorPromise).not.toBeNull();
    // A fresh AbortController was minted for the new generator (matches the
    // existing "reset aborted controller before starting" behavior).
    expect(session.abortController).not.toBe(originalAbortController);
    expect(session.abortController.signal.aborted).toBe(false);

    // Queue/conversationHistory preserved across the switch (#2756 requirement).
    expect(session.conversationHistory).toBe(originalConversationHistory);
    expect(session.claimedMessageIds).toBe(originalClaimedMessageIds);
    expect(session.abortReason ?? null).toBeNull(); // consumed by handleGeneratorExit

    // finalizeSession/removeSessionImmediate must NOT have run for the parked
    // switch — that would have disposed the in-RAM buffer/queue.
    expect(completionHandler.finalizeSession).not.toHaveBeenCalled();
    expect(sessionManager.removeSessionImmediate).not.toHaveBeenCalled();
  });

  it('does not touch a generator that already acquired its slot (mid-response)', async () => {
    const sessionDbId = 900002;
    const session = makeFakeSession(sessionDbId);

    // Never resolves on its own — simulates an in-flight, slot-acquired
    // generator that is mid-response. No occupant/waitForSlot involved at
    // all, so isSessionParkedForSlot() is naturally false for this session.
    const sdkAgent = { startSession: mock(() => new Promise<void>(() => {})) };
    const geminiAgent = { startSession: mock(() => Promise.resolve()) };
    const openRouterAgent = { startSession: mock(() => Promise.resolve()) };

    const { routes } = makeRoutes(session, { sdkAgent, geminiAgent, openRouterAgent });

    await routes.ensureGeneratorRunning(sessionDbId, 'init');
    expect(sdkAgent.startSession).toHaveBeenCalledTimes(1);
    expect(isSessionParkedForSlot(sessionDbId)).toBe(false);

    const originalAbortController = session.abortController;
    const originalGeneratorPromise = session.generatorPromise;

    providerSelectionBox.current = 'openrouter';
    await routes.ensureGeneratorRunning(sessionDbId, 'ingest');

    // Nothing aborted, nothing switched — the existing log-only fallback.
    expect(originalAbortController.signal.aborted).toBe(false);
    expect(session.abortController).toBe(originalAbortController);
    expect(session.generatorPromise).toBe(originalGeneratorPromise);
    expect(session.currentProvider).toBe('claude');
    expect(openRouterAgent.startSession).not.toHaveBeenCalled();
  });

  it('leaves an openrouter session\'s provider-change path unaffected (never parked, by construction)', async () => {
    const sessionDbId = 900003;
    const session = makeFakeSession(sessionDbId);

    // openrouter never calls waitForSlot in production, so nothing ever
    // registers this sessionId in slotWaiters — isSessionParkedForSlot must
    // be false throughout, and the log-only fallback must fire unchanged.
    const sdkAgent = { startSession: mock(() => Promise.resolve()) };
    const geminiAgent = { startSession: mock(() => Promise.resolve()) };
    const openRouterAgent = { startSession: mock(() => new Promise<void>(() => {})) };

    const { routes } = makeRoutes(session, { sdkAgent, geminiAgent, openRouterAgent });

    providerSelectionBox.current = 'openrouter';
    await routes.ensureGeneratorRunning(sessionDbId, 'init');
    expect(openRouterAgent.startSession).toHaveBeenCalledTimes(1);
    expect(isSessionParkedForSlot(sessionDbId)).toBe(false);

    const originalAbortController = session.abortController;

    providerSelectionBox.current = 'claude';
    await routes.ensureGeneratorRunning(sessionDbId, 'ingest');

    expect(isSessionParkedForSlot(sessionDbId)).toBe(false);
    expect(originalAbortController.signal.aborted).toBe(false);
    expect(session.abortController).toBe(originalAbortController);
    expect(session.currentProvider).toBe('openrouter');
    expect(sdkAgent.startSession).not.toHaveBeenCalled();
  });

  /**
   * #2756 round-3 review finding (important): ensureGeneratorRunning is
   * called from independent HTTP request handlers, so two calls for the
   * SAME sessionDbId can genuinely overlap in real usage. Both branches of
   * the old method had an async gap between reading
   * session.generatorPromise/currentProvider and the eventual
   * startGeneratorWithProvider call that reassigns them; a second call
   * landing in that gap saw stale state and started its own generator —
   * two live generators for one session. ensureGeneratorRunning now
   * serializes calls per sessionDbId via a promise-chained lock so a
   * second call's body cannot even begin until the first one's has fully
   * settled, regardless of how the two calls interleave.
   */
  describe('ensureGeneratorRunning — concurrent-call serialization (#2756 round 3)', () => {
    it('two concurrent fresh-start calls on the same never-started session only start ONE generator', async () => {
      const sessionDbId = 900004;
      const session = makeFakeSession(sessionDbId);

      const sdkAgent = { startSession: mock(() => new Promise<void>(() => {})) };
      const geminiAgent = { startSession: mock(() => Promise.resolve()) };
      const openRouterAgent = { startSession: mock(() => Promise.resolve()) };

      const { routes } = makeRoutes(session, { sdkAgent, geminiAgent, openRouterAgent });

      // Fired back-to-back with NO await between them, so both calls'
      // synchronous prefixes (in the pre-fix code, that ran up to the first
      // `await`) would have raced against the same `!session.generatorPromise`
      // check. With the lock, the second call's body cannot start running
      // at all until the first one's `.then()` chain settles.
      const p1 = routes.ensureGeneratorRunning(sessionDbId, 'init-a');
      const p2 = routes.ensureGeneratorRunning(sessionDbId, 'init-b');
      await Promise.all([p1, p2]);

      expect(sdkAgent.startSession).toHaveBeenCalledTimes(1);
      expect(session.currentProvider).toBe('claude');
    });

    it('a concurrent call landing while a provider-switch-while-parked call is mid-flight does not double-start the new provider', async () => {
      const sessionDbId = 900005;
      const session = makeFakeSession(sessionDbId);

      registerFakeOccupant('occupant-for-900005');

      const sdkAgent = {
        startSession: mock((s: ActiveSession) => waitForSlot(1, s.abortController.signal, s.sessionDbId)),
      };
      const geminiAgent = { startSession: mock(() => Promise.resolve()) };
      const openRouterAgent = { startSession: mock(() => new Promise<void>(() => {})) };

      const { routes } = makeRoutes(session, { sdkAgent, geminiAgent, openRouterAgent });

      // Parks the claude generator, exactly like the first test in this file.
      await routes.ensureGeneratorRunning(sessionDbId, 'init');
      expect(isSessionParkedForSlot(sessionDbId)).toBe(true);

      // Stub the private applyTierRouting() to pause p1 exactly in the
      // review-finding's race window: by the time this stub is reached,
      // the parked switch has already aborted the old generator and its
      // handleGeneratorExit chain has already nulled
      // session.generatorPromise/currentProvider (that's what
      // `await oldGeneratorPromise` inside ensureGeneratorRunning waited
      // for) — but startGeneratorWithProvider has NOT yet run. A second,
      // unserialized call landing here would see the nulled state and
      // start its own generator too.
      let tierRoutingReached = false;
      let releaseTierRouting!: () => void;
      const tierRoutingGate = new Promise<void>(resolve => { releaseTierRouting = resolve; });
      (routes as any).applyTierRouting = async () => {
        tierRoutingReached = true;
        await tierRoutingGate;
      };

      providerSelectionBox.current = 'openrouter';
      const p1 = routes.ensureGeneratorRunning(sessionDbId, 'ingest-a');

      // Poll (bounded) until p1 has actually reached the gated
      // applyTierRouting call — i.e. is now suspended exactly inside the
      // race window described above.
      for (let i = 0; i < 1000 && !tierRoutingReached; i++) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      expect(tierRoutingReached).toBe(true);
      // Confirms we are inside the window: the old generator's cleanup has
      // already nulled these, and nothing has reassigned them yet.
      expect(session.generatorPromise).toBeNull();
      expect(session.currentProvider).toBeNull();

      // A second call for the SAME session lands right now, while p1 is
      // parked on the gate. Pre-fix, this would independently see
      // generatorPromise === null and start its own generator concurrently
      // with p1. With the lock, p2's body cannot run at all until p1's
      // tail settles.
      const p2 = routes.ensureGeneratorRunning(sessionDbId, 'ingest-b');

      // Give p2 every chance to (incorrectly) run ahead before we release
      // p1 — it must not have called startSession yet.
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(openRouterAgent.startSession).not.toHaveBeenCalled();

      releaseTierRouting();
      await Promise.all([p1, p2]);

      // Exactly one generator was started for the new provider — p2 ran
      // only after p1 fully finished, saw currentProvider already equal
      // to the selected provider, and correctly no-op'd.
      expect(openRouterAgent.startSession).toHaveBeenCalledTimes(1);
      expect(session.currentProvider).toBe('openrouter');
    });
  });
});
