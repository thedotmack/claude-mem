import { describe, it, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  isQuotaCooldownActive,
  tryAdmitQuotaProbe,
  releaseQuotaProbe,
  recordQuotaExhausted,
  clearQuotaCooldown,
  getQuotaCooldown,
  resetQuotaCooldownsForTesting,
  syncObserverHealthQuotaCooldown,
  QUOTA_COOLDOWN_FILENAME,
  QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS,
  RATE_LIMIT_RECHECK_COOLDOWN_MS,
  resolveQuotaCooldownMs,
  QUOTA_PROBE_STALE_MS,
  isQuotaCooldownHolding,
  setClaudeProfileResolverForTesting,
  setQuotaFallbackResolver,
  type QuotaFallbackResolver,
} from '../../src/shared/quota-cooldown.js';
import {
  isObserverQuotaCooldownActive,
  isObserverUnhealthy,
  OBSERVER_HEALTH_FILENAME,
  readObserverHealth,
  recordObserverQuotaCooldown,
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
    recordQuotaExhausted('claude', 'Weekly limit reached', undefined, armedAt);

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
    recordQuotaExhausted('claude', 'Weekly limit reached', undefined, armedAt);
    const afterExpiry = armedAt + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + 1;

    const admitted = Array.from({ length: 28 }, () =>
      tryAdmitQuotaProbe('claude', afterExpiry)
    ).filter(result => result.admitted);

    expect(admitted).toHaveLength(1);
  });

  it('keeps withholding while the claimed probe is still in flight', () => {
    const armedAt = Date.now();
    recordQuotaExhausted('claude', 'Weekly limit reached', undefined, armedAt);
    const afterExpiry = armedAt + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + 1;

    expect(tryAdmitQuotaProbe('claude', afterExpiry).admitted).toBe(true);
    // Much later, but still unresolved and not yet stale.
    expect(tryAdmitQuotaProbe('claude', afterExpiry + QUOTA_PROBE_STALE_MS - 1).admitted).toBe(false);
  });

  it('re-admits once a claimed probe goes stale, so a dead generator cannot wedge the provider shut', () => {
    const armedAt = Date.now();
    recordQuotaExhausted('claude', 'Weekly limit reached', undefined, armedAt);
    const afterExpiry = armedAt + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + 1;

    expect(tryAdmitQuotaProbe('claude', afterExpiry).admitted).toBe(true);
    expect(tryAdmitQuotaProbe('claude', afterExpiry + QUOTA_PROBE_STALE_MS + 1).admitted).toBe(true);
  });

  it('releases the claim on a generator exit that neither succeeded nor re-armed', () => {
    const armedAt = Date.now();
    recordQuotaExhausted('claude', 'Weekly limit reached', undefined, armedAt);
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
    recordQuotaExhausted('claude', 'Weekly limit reached', undefined, armedAt);
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
    recordQuotaExhausted('claude', 'Weekly limit reached', undefined, armedAt);
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
    recordQuotaExhausted('claude', 'Weekly limit reached', undefined, firstArmedAt);
    const afterFirstExpiry = firstArmedAt + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + 1;

    const first = tryAdmitQuotaProbe('claude', afterFirstExpiry);
    expect(first.admitted).toBe(true);

    // That probe succeeded, so the breaker went away entirely...
    clearQuotaCooldown('claude');
    // ...and a later exhaustion armed a fresh one that has since expired.
    const secondArmedAt = Date.now();
    recordQuotaExhausted('claude', 'Weekly limit reached', undefined, secondArmedAt);
    const afterSecondExpiry = secondArmedAt + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + 1;

    const second = tryAdmitQuotaProbe('claude', afterSecondExpiry);
    expect(second.admitted).toBe(true);

    // The first generator's exit must not reopen the second breaker.
    releaseQuotaProbe('claude', first.claimId);

    expect(tryAdmitQuotaProbe('claude', afterSecondExpiry).admitted).toBe(false);
  });

  it('clears the in-flight claim when the probe fails and re-arms', () => {
    const armedAt = Date.now();
    recordQuotaExhausted('claude', 'Weekly limit reached', undefined, armedAt);
    const afterExpiry = armedAt + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + 1;
    expect(tryAdmitQuotaProbe('claude', afterExpiry).admitted).toBe(true);

    // The probe earned another refusal.
    const reArmed = recordQuotaExhausted('claude', 'Weekly limit reached');

    expect(reArmed.probeInFlightSinceMs).toBeNull();
    // And the fresh window withholds again.
    expect(tryAdmitQuotaProbe('claude', reArmed.armedAtMs + 1).admitted).toBe(false);
  });

  it('scopes the probe claim per provider', () => {
    // One start time for both records. By default each record reads the clock
    // itself, and the claude one first loads settings.json to resolve its
    // credential profile (#4272), so under load the openrouter window opened a
    // few ms after armedAt and afterExpiry fell inside it.
    const armedAt = Date.now();
    recordQuotaExhausted('claude', 'Weekly limit reached', undefined, armedAt);
    recordQuotaExhausted('openrouter', 'Spend cap reached', undefined, armedAt);
    const afterExpiry = armedAt + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + 1;

    expect(tryAdmitQuotaProbe('claude', afterExpiry).admitted).toBe(true);
    // Claiming claude's probe must not consume openrouter's.
    expect(tryAdmitQuotaProbe('openrouter', afterExpiry).admitted).toBe(true);
  });

  it('bounds capped traffic to one probe per window instead of one per observation', () => {
    // Reproduces the reported shape: a capped user keeps working, so a tool call
    // arrives every few seconds for the rest of the billing cycle.
    const armedAt = Date.now();
    recordQuotaExhausted('claude', 'Weekly limit reached', undefined, armedAt);

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
    // Both reach this breaker through recordQuotaExhausted, so the window
    // string is the only thing separating a six-second throttle from a spent
    // billing period.
    const armedAt = Date.now();
    recordQuotaExhausted('gemini', 'Provider rate limited the request', 'rate_limit', armedAt);

    expect(isQuotaCooldownActive('gemini', armedAt + RATE_LIMIT_RECHECK_COOLDOWN_MS - 1)).toBe(true);
    expect(isQuotaCooldownActive('gemini', armedAt + RATE_LIMIT_RECHECK_COOLDOWN_MS + 1)).toBe(false);
    // The default cooldown would still be withholding here.
    expect(RATE_LIMIT_RECHECK_COOLDOWN_MS).toBeLessThan(QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS);
  });

  it('admits the post-expiry probe on the short window too', () => {
    const armedAt = Date.now();
    recordQuotaExhausted('gemini', 'Provider rate limited the request', 'rate_limit', armedAt);

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
    recordQuotaExhausted('gemini', 'Provider rate limited the request', 'rate_limit', armedAt);

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
    recordQuotaExhausted('claude', 'Weekly limit reached', 'weekly', armedAt);
    recordQuotaExhausted('openrouter', 'Spend cap reached', undefined, armedAt);

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

  it('mirrors the pause that holds longest, not the one armed last', () => {
    // A throttle armed after a spent allowance clears in ninety seconds; the
    // allowance still has most of half an hour to run. Mirroring whichever was
    // armed last would drop the banner while capture is still paused.
    const healthPath = join(paths.dataDir(), OBSERVER_HEALTH_FILENAME);
    const now = Date.now();
    recordQuotaExhausted('claude', 'Weekly limit reached', 'weekly', now - 60_000);
    recordQuotaExhausted('gemini', 'Provider rate limited the request', 'rate_limit', now);

    syncObserverHealthQuotaCooldown(now);
    const mirrored = readObserverHealth(healthPath)!.quotaCooldown!;
    expect(mirrored.provider).toBe('claude');
    expect(mirrored.until).toBe(now - 60_000 + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS);

    // Each window expires on its own clock: past the throttle, the allowance
    // is still the live pause.
    syncObserverHealthQuotaCooldown(now + RATE_LIMIT_RECHECK_COOLDOWN_MS + 1);
    expect(readObserverHealth(healthPath)!.quotaCooldown!.provider).toBe('claude');
  });

  it('re-mirrors windows armed by an older build when it reloads them', () => {
    // A build that held every window for the quota cooldown wrote that `until`
    // into observer-health.json. The breaker now resolves a rate-limit window
    // to ninety seconds; a reload that left the old mirror alone would keep the
    // banner up for half an hour on a throttle the breaker already released.
    const healthPath = join(paths.dataDir(), OBSERVER_HEALTH_FILENAME);
    const armedAt = Date.now();
    writeFileSync(
      join(paths.dataDir(), QUOTA_COOLDOWN_FILENAME),
      JSON.stringify([{ provider: 'gemini', message: 'Provider rate limited the request', window: 'rate_limit', armedAtMs: armedAt }]),
    );
    recordObserverQuotaCooldown({
      active: true,
      provider: 'gemini',
      armedAt,
      until: armedAt + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS,
      window: 'rate_limit',
      message: 'Provider rate limited the request',
    }, healthPath);

    // First read in this "process" hydrates from disk.
    expect(getQuotaCooldown('gemini')?.window).toBe('rate_limit');
    expect(readObserverHealth(healthPath)!.quotaCooldown!.until).toBe(armedAt + RATE_LIMIT_RECHECK_COOLDOWN_MS);
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

  it('stops mirroring a cooldown once its window has elapsed, but keeps its admission state (#4114)', () => {
    const healthPath = join(paths.dataDir(), OBSERVER_HEALTH_FILENAME);
    const armedAt = Date.now();
    recordQuotaExhausted('claude', 'Weekly limit reached', 'weekly', armedAt);
    expect(readObserverHealth(healthPath)!.quotaCooldown!.active).toBe(true);

    // A mirror pass after the window elapsed must not report the pause active —
    // admission already lets a probe through, so the banner would be stale.
    syncObserverHealthQuotaCooldown(armedAt + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + 1);

    const health = readObserverHealth(healthPath);
    expect(health === null || health.quotaCooldown === null).toBe(true);
    // The breaker stays in the store: it still gates the single recovery probe.
    expect(getQuotaCooldown('claude')).not.toBeNull();
  });

  it('never mirrors an elapsed window, even after the live one clears (#4114)', () => {
    const healthPath = join(paths.dataDir(), OBSERVER_HEALTH_FILENAME);
    const now = Date.now();
    // gemini was capped two windows ago; claude is capped now.
    recordQuotaExhausted('gemini', 'Old weekly limit', 'weekly', now - QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS * 2);
    recordQuotaExhausted('claude', 'Weekly limit reached', 'weekly', now);

    // Live claude is mirrored; elapsed gemini is not.
    syncObserverHealthQuotaCooldown(now);
    expect(readObserverHealth(healthPath)!.quotaCooldown!.provider).toBe('claude');

    // claude recovers. gemini's elapsed breaker must not resurface in the mirror.
    clearQuotaCooldown('claude');
    const health = readObserverHealth(healthPath);
    expect(health === null || health.quotaCooldown === null).toBe(true);
    // gemini's admission state is retained for its own future recovery probe.
    expect(getQuotaCooldown('gemini')).not.toBeNull();
  });

  it('keeps an elapsed breaker when another provider is recorded, admitting one probe not all (#4116)', () => {
    const now = Date.now();
    // claude's window elapsed two windows ago and it has not recovered.
    recordQuotaExhausted('claude', 'Weekly limit reached', undefined, now - QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS * 2);
    // Recording a second provider runs the mirror pass; it must not drop claude.
    recordQuotaExhausted('gemini', 'Spend cap reached');
    expect(getQuotaCooldown('claude')).not.toBeNull();

    // So concurrent recovery traffic still gets exactly one probe, not a burst.
    const admitted = Array.from({ length: 10 }, () =>
      tryAdmitQuotaProbe('claude', now)
    ).filter(result => result.admitted);
    expect(admitted).toHaveLength(1);
  });
});

describe('isQuotaCooldownHolding (quota fallback)', () => {
  beforeEach(() => {
    resetQuotaCooldownsForTesting();
  });

  // The breaker is process-global and these tests arm it, on disk as well.
  afterEach(() => {
    resetQuotaCooldownsForTesting();
  });

  it('is false when no breaker is armed', () => {
    expect(isQuotaCooldownHolding('gemini')).toBe(false);
  });

  it('holds for the whole cooldown window', () => {
    const armedAt = Date.now();
    recordQuotaExhausted('gemini', 'Daily limit reached', undefined, armedAt);
    expect(isQuotaCooldownHolding('gemini', armedAt + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS - 1)).toBe(true);
  });

  it('holds a rate-limit window only for the short cooldown', () => {
    const armedAt = Date.now();
    recordQuotaExhausted('gemini', 'Provider rate limited the request', 'rate_limit', armedAt);
    expect(isQuotaCooldownHolding('gemini', armedAt + RATE_LIMIT_RECHECK_COOLDOWN_MS - 1)).toBe(true);
    expect(isQuotaCooldownHolding('gemini', armedAt + RATE_LIMIT_RECHECK_COOLDOWN_MS + 1)).toBe(false);
  });

  it('stops holding once the window elapses with no probe in flight, so the primary can claim its probe', () => {
    recordQuotaExhausted('gemini', 'Daily limit reached', undefined, Date.now() - QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS - 1);
    expect(isQuotaCooldownHolding('gemini')).toBe(false);
  });

  it('holds while the single post-expiry probe is in flight and fresh', () => {
    recordQuotaExhausted('gemini', 'Daily limit reached', undefined, Date.now() - QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS - 1);
    const claimedAt = Date.now();
    expect(tryAdmitQuotaProbe('gemini', claimedAt).admitted).toBe(true);
    expect(isQuotaCooldownHolding('gemini', claimedAt + QUOTA_PROBE_STALE_MS - 1)).toBe(true);
  });

  it('stops holding once that probe goes stale', () => {
    recordQuotaExhausted('gemini', 'Daily limit reached', undefined, Date.now() - QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS - 1);
    const claimedAt = Date.now();
    expect(tryAdmitQuotaProbe('gemini', claimedAt).admitted).toBe(true);
    expect(isQuotaCooldownHolding('gemini', claimedAt + QUOTA_PROBE_STALE_MS)).toBe(false);
  });

  it('never claims the probe', () => {
    recordQuotaExhausted('gemini', 'Daily limit reached', undefined, Date.now() - QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS - 1);
    isQuotaCooldownHolding('gemini');
    isQuotaCooldownHolding('gemini');
    expect(getQuotaCooldown('gemini')!.probeInFlightSinceMs).toBeNull();
    expect(tryAdmitQuotaProbe('gemini').admitted).toBe(true);
  });

  it('is scoped per provider', () => {
    recordQuotaExhausted('gemini', 'Daily limit reached');
    expect(isQuotaCooldownHolding('gemini')).toBe(true);
    expect(isQuotaCooldownHolding('claude')).toBe(false);
  });

  it('does not hold a Claude breaker armed under another account', () => {
    setClaudeProfileResolverForTesting(() => 'account-a');
    recordQuotaExhausted('claude', 'Weekly limit reached');
    expect(isQuotaCooldownHolding('claude')).toBe(true);
    setClaudeProfileResolverForTesting(() => 'account-b');
    expect(isQuotaCooldownHolding('claude')).toBe(false);
  });

  it('sees a breaker armed by a previous worker process', () => {
    // A restart must not send work back to a provider whose window is still open.
    mkdirSync(paths.dataDir(), { recursive: true });
    writeFileSync(
      join(paths.dataDir(), QUOTA_COOLDOWN_FILENAME),
      JSON.stringify([{ provider: 'gemini', message: 'armed before the restart', armedAtMs: Date.now() - 60_000 }]),
    );
    expect(isQuotaCooldownHolding('gemini')).toBe(true);
  });
});

describe('quota fallback annotation on the mirrored cooldown', () => {
  const healthPath = (): string => join(paths.dataDir(), OBSERVER_HEALTH_FILENAME);
  let restore: QuotaFallbackResolver | null = null;

  beforeEach(() => {
    resetQuotaCooldownsForTesting();
  });

  afterEach(() => {
    setQuotaFallbackResolver(restore);
    resetQuotaCooldownsForTesting();
  });

  it('records where capture continues while the breaker holds', () => {
    restore = setQuotaFallbackResolver((provider) => (provider === 'gemini' ? 'claude' : null));
    recordQuotaExhausted('gemini', 'Daily limit reached');
    expect(readObserverHealth(healthPath())!.quotaCooldown!.servingProvider).toBe('claude');
  });

  it('records no serving provider when none can serve, so the notice still says paused', () => {
    restore = setQuotaFallbackResolver(() => null);
    recordQuotaExhausted('gemini', 'Daily limit reached');
    expect(readObserverHealth(healthPath())!.quotaCooldown!.servingProvider).toBeUndefined();
  });

  it('asks the resolver about the pause it mirrors when the fallback arms its own', () => {
    restore = setQuotaFallbackResolver((provider) => (provider === 'gemini' ? 'claude' : null));
    recordQuotaExhausted('gemini', 'Daily limit reached', undefined, Date.now() - 1000);
    recordQuotaExhausted('claude', 'Weekly limit reached');
    const mirrored = readObserverHealth(healthPath())!.quotaCooldown!;
    expect(mirrored.provider).toBe('claude');
    expect(mirrored.servingProvider).toBeUndefined();
  });

  it('still mirrors the cooldown when the resolver throws', () => {
    restore = setQuotaFallbackResolver(() => {
      throw new Error('settings unreadable');
    });
    recordQuotaExhausted('gemini', 'Daily limit reached');
    const mirrored = readObserverHealth(healthPath())!.quotaCooldown!;
    expect(mirrored.provider).toBe('gemini');
    expect(mirrored.servingProvider).toBeUndefined();
  });
});
