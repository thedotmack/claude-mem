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
    expect(tryAdmitQuotaProbe('claude')).toBe(true);
    expect(tryAdmitQuotaProbe('claude')).toBe(true);
  });

  it('withholds every caller while the window is still cooling', () => {
    recordQuotaExhausted('claude', 'Weekly limit reached');

    expect(tryAdmitQuotaProbe('claude')).toBe(false);
    expect(tryAdmitQuotaProbe('claude')).toBe(false);
  });

  it('admits exactly ONE concurrent caller after expiry, not all of them', () => {
    // The reported machine ran 28-69 live sessions; they all observe the window
    // elapse at the same instant, so a bare time check would let them all send.
    const armedAt = Date.now();
    recordQuotaExhausted('claude', 'Weekly limit reached');
    const afterExpiry = armedAt + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + 1;

    const admitted = Array.from({ length: 28 }, () =>
      tryAdmitQuotaProbe('claude', afterExpiry)
    ).filter(Boolean);

    expect(admitted).toHaveLength(1);
  });

  it('keeps withholding while the claimed probe is still in flight', () => {
    const armedAt = Date.now();
    recordQuotaExhausted('claude', 'Weekly limit reached');
    const afterExpiry = armedAt + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + 1;

    expect(tryAdmitQuotaProbe('claude', afterExpiry)).toBe(true);
    // Much later, but still unresolved and not yet stale.
    expect(tryAdmitQuotaProbe('claude', afterExpiry + QUOTA_PROBE_STALE_MS - 1)).toBe(false);
  });

  it('re-admits once a claimed probe goes stale, so a dead generator cannot wedge the provider shut', () => {
    const armedAt = Date.now();
    recordQuotaExhausted('claude', 'Weekly limit reached');
    const afterExpiry = armedAt + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + 1;

    expect(tryAdmitQuotaProbe('claude', afterExpiry)).toBe(true);
    expect(tryAdmitQuotaProbe('claude', afterExpiry + QUOTA_PROBE_STALE_MS + 1)).toBe(true);
  });

  it('releases the claim on a generator exit that neither succeeded nor re-armed', () => {
    const armedAt = Date.now();
    recordQuotaExhausted('claude', 'Weekly limit reached');
    const afterExpiry = armedAt + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + 1;

    expect(tryAdmitQuotaProbe('claude', afterExpiry)).toBe(true);
    expect(tryAdmitQuotaProbe('claude', afterExpiry)).toBe(false);

    releaseQuotaProbe('claude');

    expect(tryAdmitQuotaProbe('claude', afterExpiry)).toBe(true);
  });

  it('clears the in-flight claim when the probe fails and re-arms', () => {
    const armedAt = Date.now();
    recordQuotaExhausted('claude', 'Weekly limit reached');
    const afterExpiry = armedAt + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + 1;
    expect(tryAdmitQuotaProbe('claude', afterExpiry)).toBe(true);

    // The probe earned another refusal.
    const reArmed = recordQuotaExhausted('claude', 'Weekly limit reached');

    expect(reArmed.probeInFlightSinceMs).toBeNull();
    // And the fresh window withholds again.
    expect(tryAdmitQuotaProbe('claude', reArmed.armedAtMs + 1)).toBe(false);
  });

  it('scopes the probe claim per provider', () => {
    const armedAt = Date.now();
    recordQuotaExhausted('claude', 'Weekly limit reached');
    recordQuotaExhausted('openrouter', 'Spend cap reached');
    const afterExpiry = armedAt + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + 1;

    expect(tryAdmitQuotaProbe('claude', afterExpiry)).toBe(true);
    // Claiming claude's probe must not consume openrouter's.
    expect(tryAdmitQuotaProbe('openrouter', afterExpiry)).toBe(true);
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
