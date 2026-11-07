import { afterEach, beforeEach } from 'bun:test';
import {
  getProcessRegistry,
  getParkedSlotWaiterCount,
  getReservedSlotCount,
} from '../../src/supervisor/process-registry.js';

/**
 * #2756 round-2 fix — waitForSlot has no injection seam (it is hardcoded to
 * the module-level getProcessRegistry() singleton, its module-level
 * slotWaiters array, and its module-level reservedSlots counter), so every
 * test file that exercises it must drive that SAME real singleton. As of
 * this PR that is FOUR files, not three:
 *   - tests/supervisor/process-registry.test.ts
 *   - tests/worker/http/routes/session-routes-provider-switch.test.ts
 *   - tests/worker/http/routes/data-routes-processing-status.test.ts
 *   - tests/supervisor/wait-for-slot.test.ts (pre-existing, upstream #3287 —
 *     not touched by this PR's own diff otherwise, but it drives
 *     waitForSlot()/getProcessRegistry() directly and so shares the exact
 *     same module-level state as the other three; leaving it unguarded
 *     would let it leak a parked waiter or a reserved-but-unregistered slot
 *     into whichever of the other three files runs next in the same
 *     process, surfacing as a confusing, misattributed failure over there
 *     instead of a loud one here)
 * (an earlier comment here claimed only the first of these plus
 * shutdown.test.ts touched process-registry.ts — that was wrong the moment
 * the other files landed; shutdown.test.ts, for the record, uses
 * createProcessRegistry() with its own temp path, never the singleton, so
 * it was never actually part of the shared-state surface).
 *
 * Every test in those four files unregisters its own fake 'sdk' entries and
 * awaits/releases its own parked waiters and reservations, so in the
 * well-behaved case the singleton is back to empty before the next test's
 * beforeEach ever runs. But `bun test` runs every matched file in ONE
 * process, and each parked waiter owns a real (unref()'d) setInterval
 * recheck timer plus a slot in the module-level `slotWaiters` FIFO array —
 * if any test anywhere in the run leaves one behind (an early throw before
 * its own cleanup step, a promise it forgot to await, a SlotReservation it
 * forgot to release, ...), that stale entry doesn't just sit there
 * inertly: notifySlotAvailable() does slotWaiters.shift() off the FRONT of
 * the array, so a later, totally unrelated test's unregister()/release()
 * can resolve/reject the WRONG (stale, foreign) waiter instead of its own —
 * producing a confusing failure far away from, and much later than, its
 * real cause. That is the leading theory for the rare (~1-in-20-runs)
 * cross-test flake this guard exists to catch instead of hide.
 *
 * Call this once at each of those four files' TRUE TOP LEVEL — outside
 * every describe() in the file, never nested inside one — to install a
 * beforeEach/afterEach pair that fails LOUDLY, naming the exact leaked
 * state, the moment the shared singleton is non-empty going into or coming
 * out of one of this file's own tests, whether the leak originated in this
 * file or arrived pre-dirtied from whichever file ran immediately before it
 * in the same `bun test` process. The top-level placement is load-bearing,
 * not stylistic: bun (like Jest/Mocha) runs afterEach hooks inner-scope-
 * first, outer-scope-last (LIFO) regardless of source order, so only a
 * hook registered OUTSIDE a file's describe()/nested-describe blocks is
 * guaranteed to run its "after" check strictly after every local cleanup
 * hook nested inside them has already run — nest this call one level in
 * (e.g. as the first statement inside a describe()) and its afterEach can
 * fire BEFORE that describe's own local cleanup, which was tried, observed
 * to fail exactly this way, and reverted; see the call sites for the
 * concrete fix (moving each file's own local beforeEach/afterEach one level
 * IN, to nest strictly inside the guard). Fix the leaking test; never relax
 * or remove this guard to make a red run green.
 *
 * NOTE on residual risk: this guard makes a leak fail loudly and names the
 * file it fired in, but a leak can still surface as a failure in whichever
 * file happens to run immediately after the one that actually leaked (bun's
 * file order within one process is not randomized per test), not
 * necessarily as a failure inside the leaking file itself. Covering every
 * file that touches this singleton (this fix) removes the *unguarded*
 * blind spot; it does not — and cannot, short of giving waitForSlot() a
 * per-test injection seam — eliminate every timing window in a shared,
 * real, module-level singleton driven by multiple files in one process.
 */
export function guardSharedProcessRegistrySingleton(label: string): void {
  const registry = getProcessRegistry();

  const assertClean = (when: 'before' | 'after') => {
    const parked = getParkedSlotWaiterCount();
    const reserved = getReservedSlotCount();
    const sdkEntries = registry.getAll().filter(r => r.type === 'sdk');
    if (parked !== 0 || reserved !== 0 || sdkEntries.length !== 0) {
      throw new Error(
        `[process-registry-singleton-guard:${label}] shared process-registry singleton is dirty ${when} a test — ` +
        `parkedSlotWaiterCount=${parked}, reservedSlotCount=${reserved}, leftover sdk entries=${JSON.stringify(sdkEntries.map(r => r.id))}. ` +
        `Some test (possibly in a different file sharing this bun test process) left a parked waiter, an ` +
        `unreleased slot reservation, or a fake 'sdk' registry entry behind instead of cleaning it up in its ` +
        `own afterEach/finally. Fix that leak rather than loosening this guard — a lingering waiter can resolve ` +
        `in place of an unrelated later test's own waiter via notifySlotAvailable()'s FIFO shift().`
      );
    }
  };

  beforeEach(() => assertClean('before'));
  afterEach(() => assertClean('after'));
}
