import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { join } from 'path';
import {
  isQuotaCooldownActive,
  tryAdmitQuotaProbe,
  releaseQuotaProbe,
  recordQuotaExhausted,
  clearQuotaCooldown,
  getQuotaCooldown,
  resetQuotaCooldownsForTesting,
  QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS,
  RATE_LIMIT_RECHECK_COOLDOWN_MS,
  resolveQuotaCooldownMs,
  QUOTA_PROBE_STALE_MS,
} from '../../src/shared/quota-cooldown.js';
import {
  isObserverQuotaCooldownActive,
  isObserverUnhealthy,
  OBSERVER_HEALTH_FILENAME,
  readObserverHealth,
} from '../../src/shared/observer-health.js';
import { paths } from '../../src/shared/paths.js';

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
    // Each provider is stamped when its own write lands, so one deadline taken
    // from a Date.now() captured before both calls is already expired for
    // whichever provider persisted second. Ask each breaker for its own stamp.
    const claude = recordQuotaExhausted('claude', 'Weekly limit reached');
    const openrouter = recordQuotaExhausted('openrouter', 'Spend cap reached');

    const claudeReady = claude.armedAtMs + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + 1;
    const openrouterReady = openrouter.armedAtMs + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + 1;

    expect(tryAdmitQuotaProbe('claude', claudeReady).admitted).toBe(true);
    // Claiming claude's probe must not consume openrouter's.
    expect(tryAdmitQuotaProbe('openrouter', openrouterReady).admitted).toBe(true);
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

  it('holds a rate-limit window for the short cooldown, not the quota one', () => {
    // Both reach this breaker through the same `quota:` abort reason, so the
    // window string is the only thing separating a six-second throttle from a
    // spent billing period.
    const armedAt = Date.now();
    recordQuotaExhausted('gemini', 'Provider rate limited the request', 'rate_limit');

    expect(isQuotaCooldownActive('gemini', armedAt + RATE_LIMIT_RECHECK_COOLDOWN_MS - 1)).toBe(true);
    expect(isQuotaCooldownActive('gemini', armedAt + RATE_LIMIT_RECHECK_COOLDOWN_MS + 1)).toBe(false);
    // The default cooldown would still be withholding here.
    expect(RATE_LIMIT_RECHECK_COOLDOWN_MS).toBeLessThan(QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS);
  });

  it('admits the post-expiry probe on the short window too', () => {
    const armedAt = Date.now();
    recordQuotaExhausted('gemini', 'Provider rate limited the request', 'rate_limit');

    expect(tryAdmitQuotaProbe('gemini', armedAt + 1).admitted).toBe(false);
    expect(tryAdmitQuotaProbe('gemini', armedAt + RATE_LIMIT_RECHECK_COOLDOWN_MS + 1).admitted).toBe(true);
  });

  it('resolves the cooldown from the window, for every caller that reports it', () => {
    // The duration has to have one source. A caller reading the quota constant
    // directly reports a half-hour wait for a throttle that clears in ninety
    // seconds, which is what the worker log line did before this.
    expect(resolveQuotaCooldownMs('rate_limit')).toBe(RATE_LIMIT_RECHECK_COOLDOWN_MS);
    expect(resolveQuotaCooldownMs('weekly')).toBe(QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS);
    // An absent window is the quota window, so an unfamiliar provider is never
    // treated as transient by accident.
    expect(resolveQuotaCooldownMs(undefined)).toBe(QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS);
  });

  it('still lets an explicit duration override the window', () => {
    // Resolving from the window must not take away the pre-existing duration
    // parameter, which is how a caller pins the window for a test.
    const armedAt = Date.now();
    recordQuotaExhausted('gemini', 'Provider rate limited the request', 'rate_limit');

    // The window alone has already admitted by here...
    expect(isQuotaCooldownActive('gemini', armedAt + RATE_LIMIT_RECHECK_COOLDOWN_MS + 1)).toBe(false);
    // ...and the explicit duration still withholds.
    expect(
      isQuotaCooldownActive(
        'gemini',
        armedAt + RATE_LIMIT_RECHECK_COOLDOWN_MS + 1,
        QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS,
      ),
    ).toBe(true);
  });

  it('keeps the quota cooldown for an unrecognised or absent window', () => {
    // An unfamiliar window must not be treated as transient by accident: the
    // short cooldown is only for windows the provider named as a throttle.
    const armedAt = Date.now();
    recordQuotaExhausted('claude', 'Weekly limit reached', 'weekly');
    recordQuotaExhausted('openrouter', 'Spend cap reached');

    expect(isQuotaCooldownActive('claude', armedAt + RATE_LIMIT_RECHECK_COOLDOWN_MS + 1)).toBe(true);
    expect(isQuotaCooldownActive('openrouter', armedAt + RATE_LIMIT_RECHECK_COOLDOWN_MS + 1)).toBe(true);
  });

  it('mirrors the rate-limit window expiry into observer-health', () => {
    const healthPath = join(paths.dataDir(), OBSERVER_HEALTH_FILENAME);
    recordQuotaExhausted('gemini', 'Provider rate limited the request', 'rate_limit');

    const armed = readObserverHealth(healthPath)!;
    expect(armed.quotaCooldown!.window).toBe('rate_limit');
    // The banner has to expire when the breaker does, or it reports a live
    // outage for a throttle that cleared twenty-eight minutes ago.
    expect(armed.quotaCooldown!.until).toBe(
      armed.quotaCooldown!.armedAt + RATE_LIMIT_RECHECK_COOLDOWN_MS,
    );
    expect(isObserverQuotaCooldownActive(armed)).toBe(true);
  });

  it('mirrors the armed window into observer-health.json and clears it on success', () => {
    const healthPath = join(paths.dataDir(), OBSERVER_HEALTH_FILENAME);
    const priorFailures = readObserverHealth(healthPath)?.consecutiveFailures ?? 0;
    recordQuotaExhausted('claude', 'Weekly limit reached', 'weekly');

    const armed = readObserverHealth(healthPath)!;
    expect(armed.consecutiveFailures).toBe(priorFailures);
    expect(armed.quotaCooldown).not.toBeNull();
    expect(armed.quotaCooldown!.active).toBe(true);
    expect(armed.quotaCooldown!.provider).toBe('claude');
    expect(armed.quotaCooldown!.window).toBe('weekly');
    expect(armed.quotaCooldown!.until).toBe(armed.quotaCooldown!.armedAt + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS);
    expect(isObserverQuotaCooldownActive(armed)).toBe(true);
    // A cooldown is not a failure: arming must not itself trip the banner.
    expect(isObserverUnhealthy({ ...armed, consecutiveFailures: 0, lastErrorAt: null })).toBe(false);

    clearQuotaCooldown('claude');
    const cleared = readObserverHealth(healthPath);
    expect(cleared === null || cleared.quotaCooldown === null).toBe(true);
    expect(isObserverQuotaCooldownActive(cleared)).toBe(false);
  });
});
