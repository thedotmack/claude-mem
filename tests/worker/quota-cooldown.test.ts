import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import {
  isQuotaCooldownActive,
  tryAdmitQuotaProbe,
  releaseQuotaProbe,
  recordQuotaExhausted,
  clearQuotaCooldown,
  getQuotaCooldown,
  resetQuotaCooldownsForTesting,
  QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS,
  QUOTA_PROBE_STALE_MS,
} from '../../src/shared/quota-cooldown.js';

describe('quota cooldown breaker (#3634)', () => {
  beforeEach(() => {
    resetQuotaCooldownsForTesting();
  });

  // The breaker is process-global by design (a user's quota is per-account, not
  // per-session), so a cooldown left armed here would gate generator starts in
  // every later test file in this bun process.
  afterAll(() => {
    resetQuotaCooldownsForTesting();
  });

  it('is inactive until a provider reports the allowance exhausted', () => {
    expect(isQuotaCooldownActive('claude')).toBe(false);
    expect(getQuotaCooldown('claude')).toBeNull();
  });

  it('withholds requests for the cooldown window once armed', () => {
    recordQuotaExhausted('claude', 'Weekly limit reached', 'weekly');

    expect(isQuotaCooldownActive('claude')).toBe(true);
    expect(getQuotaCooldown('claude')?.window).toBe('weekly');
  });

  it('is scoped per provider — one capped provider does not gate the others', () => {
    recordQuotaExhausted('openrouter', 'Spend cap reached');

    expect(isQuotaCooldownActive('openrouter')).toBe(true);
    expect(isQuotaCooldownActive('claude')).toBe(false);
    expect(isQuotaCooldownActive('gemini')).toBe(false);
  });

  it('lets exactly one probe through once the window elapses', () => {
    const armedAt = Date.now();
    recordQuotaExhausted('claude', 'Weekly limit reached');

    const justBefore = armedAt + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS - 1;
    const justAfter = armedAt + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + 1;

    expect(isQuotaCooldownActive('claude', justBefore)).toBe(true);
    expect(isQuotaCooldownActive('claude', justAfter)).toBe(false);
    // State is retained after expiry so a failed probe can re-arm rather than
    // starting from a clean slate.
    expect(getQuotaCooldown('claude')).not.toBeNull();
  });

  it('re-arms on a failed probe, restamping the window', () => {
    recordQuotaExhausted('claude', 'Weekly limit reached');
    const first = getQuotaCooldown('claude')!.armedAtMs;

    const reArmed = recordQuotaExhausted('claude', 'Weekly limit reached');

    expect(reArmed.armedAtMs).toBeGreaterThanOrEqual(first);
    expect(isQuotaCooldownActive('claude', reArmed.armedAtMs + 1)).toBe(true);
  });

  it('clears immediately on success so recovery does not wait out the window', () => {
    recordQuotaExhausted('claude', 'Weekly limit reached');
    expect(isQuotaCooldownActive('claude')).toBe(true);

    clearQuotaCooldown('claude');

    expect(isQuotaCooldownActive('claude')).toBe(false);
    expect(getQuotaCooldown('claude')).toBeNull();
  });

  it('admits every caller when no breaker is armed', () => {
    // No breaker means no probe to own, so neither admission carries a claim.
    expect(tryAdmitQuotaProbe('claude')).toEqual({ admitted: true, claimId: null });
    expect(tryAdmitQuotaProbe('claude')).toEqual({ admitted: true, claimId: null });
  });

  it('withholds every caller while the window is still cooling', () => {
    recordQuotaExhausted('claude', 'Weekly limit reached');

    expect(tryAdmitQuotaProbe('claude').admitted).toBe(false);
    expect(tryAdmitQuotaProbe('claude').admitted).toBe(false);
  });

  it('admits exactly ONE concurrent caller after expiry, not all of them', () => {
    // The reported machine ran 28-69 live sessions; they all observe the window
    // elapse at the same instant, so a bare time check would let them all send.
    const armedAt = Date.now();
    recordQuotaExhausted('claude', 'Weekly limit reached');
    const afterExpiry = armedAt + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + 1;

    const admitted = Array.from({ length: 28 }, () =>
      tryAdmitQuotaProbe('claude', afterExpiry)
    ).filter(result => result.admitted);

    expect(admitted).toHaveLength(1);
  });

  it('keeps withholding while the claimed probe is still in flight', () => {
    const armedAt = Date.now();
    recordQuotaExhausted('claude', 'Weekly limit reached');
    const afterExpiry = armedAt + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + 1;

    expect(tryAdmitQuotaProbe('claude', afterExpiry).admitted).toBe(true);
    // Much later, but still unresolved and not yet stale.
    expect(tryAdmitQuotaProbe('claude', afterExpiry + QUOTA_PROBE_STALE_MS - 1).admitted).toBe(false);
  });

  it('re-admits once a claimed probe goes stale, so a dead generator cannot wedge the provider shut', () => {
    const armedAt = Date.now();
    recordQuotaExhausted('claude', 'Weekly limit reached');
    const afterExpiry = armedAt + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + 1;

    expect(tryAdmitQuotaProbe('claude', afterExpiry).admitted).toBe(true);
    expect(tryAdmitQuotaProbe('claude', afterExpiry + QUOTA_PROBE_STALE_MS + 1).admitted).toBe(true);
  });

  it('releases the claim on a generator exit that neither succeeded nor re-armed', () => {
    const armedAt = Date.now();
    recordQuotaExhausted('claude', 'Weekly limit reached');
    const afterExpiry = armedAt + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + 1;

    const claim = tryAdmitQuotaProbe('claude', afterExpiry);
    expect(claim.admitted).toBe(true);
    expect(tryAdmitQuotaProbe('claude', afterExpiry).admitted).toBe(false);

    releaseQuotaProbe('claude', claim.claimId);

    expect(tryAdmitQuotaProbe('claude', afterExpiry).admitted).toBe(true);
  });

  it('does not let a generator admitted before the breaker release a later session\u2019s probe', () => {
    // The overlap that made an unscoped release wrong: session A started while
    // the provider was healthy, so it owns no probe at all. The breaker then
    // arms and expires, session B claims the sole probe, and only afterwards
    // does A's long-running generator exit.
    const sessionA = tryAdmitQuotaProbe('claude');
    expect(sessionA).toEqual({ admitted: true, claimId: null });

    const armedAt = Date.now();
    recordQuotaExhausted('claude', 'Weekly limit reached');
    const afterExpiry = armedAt + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + 1;

    const sessionB = tryAdmitQuotaProbe('claude', afterExpiry);
    expect(sessionB.admitted).toBe(true);

    // A exits. Its request is long over, but B's probe is still in flight.
    releaseQuotaProbe('claude', sessionA.claimId);

    // Session C must stay withheld: B is still waiting on the provider.
    expect(tryAdmitQuotaProbe('claude', afterExpiry).admitted).toBe(false);
    expect(getQuotaCooldown('claude')?.probeInFlightSinceMs).toBe(afterExpiry);
  });

  it('does not let the owner of a stale probe release the takeover that replaced it', () => {
    const armedAt = Date.now();
    recordQuotaExhausted('claude', 'Weekly limit reached');
    const afterExpiry = armedAt + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + 1;

    const abandoned = tryAdmitQuotaProbe('claude', afterExpiry);
    expect(abandoned.admitted).toBe(true);

    // Its generator never reached any exit path, so the claim went stale and
    // the next caller took over.
    const takeover = tryAdmitQuotaProbe('claude', afterExpiry + QUOTA_PROBE_STALE_MS + 1);
    expect(takeover.admitted).toBe(true);
    expect(takeover.claimId).not.toBe(abandoned.claimId);

    // The abandoned generator finally dies and releases.
    releaseQuotaProbe('claude', abandoned.claimId);

    expect(tryAdmitQuotaProbe('claude', afterExpiry + QUOTA_PROBE_STALE_MS + 2).admitted).toBe(false);
  });

  it('does not let a probe from a cleared breaker release the probe of the next one', () => {
    const firstArmedAt = Date.now();
    recordQuotaExhausted('claude', 'Weekly limit reached');
    const afterFirstExpiry = firstArmedAt + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + 1;

    const first = tryAdmitQuotaProbe('claude', afterFirstExpiry);
    expect(first.admitted).toBe(true);

    // That probe succeeded, so the breaker went away entirely...
    clearQuotaCooldown('claude');
    // ...and a later exhaustion armed a fresh one that has since expired.
    const secondArmedAt = Date.now();
    recordQuotaExhausted('claude', 'Weekly limit reached');
    const afterSecondExpiry = secondArmedAt + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + 1;

    const second = tryAdmitQuotaProbe('claude', afterSecondExpiry);
    expect(second.admitted).toBe(true);

    // The first generator's exit must not reopen the second breaker.
    releaseQuotaProbe('claude', first.claimId);

    expect(tryAdmitQuotaProbe('claude', afterSecondExpiry).admitted).toBe(false);
  });

  it('clears the in-flight claim when the probe fails and re-arms', () => {
    const armedAt = Date.now();
    recordQuotaExhausted('claude', 'Weekly limit reached');
    const afterExpiry = armedAt + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + 1;
    expect(tryAdmitQuotaProbe('claude', afterExpiry).admitted).toBe(true);

    // The probe earned another refusal.
    const reArmed = recordQuotaExhausted('claude', 'Weekly limit reached');

    expect(reArmed.probeInFlightSinceMs).toBeNull();
    // And the fresh window withholds again.
    expect(tryAdmitQuotaProbe('claude', reArmed.armedAtMs + 1).admitted).toBe(false);
  });

  it('scopes the probe claim per provider', () => {
    const armedAt = Date.now();
    recordQuotaExhausted('claude', 'Weekly limit reached');
    recordQuotaExhausted('openrouter', 'Spend cap reached');
    const afterExpiry = armedAt + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + 1;

    expect(tryAdmitQuotaProbe('claude', afterExpiry).admitted).toBe(true);
    // Claiming claude's probe must not consume openrouter's.
    expect(tryAdmitQuotaProbe('openrouter', afterExpiry).admitted).toBe(true);
  });

  it('bounds capped traffic to one probe per window instead of one per observation', () => {
    // Reproduces the reported shape: a capped user keeps working, so a tool call
    // arrives every few seconds for the rest of the billing cycle.
    const armedAt = Date.now();
    recordQuotaExhausted('claude', 'Weekly limit reached');

    let requestsSent = 0;
    for (let elapsed = 0; elapsed < QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS * 2; elapsed += 5_000) {
      if (!isQuotaCooldownActive('claude', armedAt + elapsed)) {
        requestsSent++;
        // A probe that fails re-arms; model that as the worst case.
        break;
      }
    }

    // Before the fix this loop sent ~720 doomed requests; now it sends one.
    expect(requestsSent).toBe(1);
  });
});
