import { afterEach, beforeEach } from 'bun:test';
import { getQuotaCooldown, type QuotaProvider } from '../../src/shared/quota-cooldown.js';
import { getCmemGatewayProbeClaim } from '../../src/services/worker/provider-dispatch.js';

const QUOTA_PROVIDERS: QuotaProvider[] = ['claude', 'gemini', 'openrouter', 'cmem-gateway'];

/**
 * #2756 round-2 review finding (important) — `tryAdmitQuotaProbe`/
 * `recordQuotaExhausted`/`releaseQuotaProbe` all read and write ONE
 * module-level `cooldowns` Map in src/shared/quota-cooldown.ts, exactly the
 * same "shared real singleton across every file in one `bun test` process"
 * shape that tests/supervisor/process-registry-singleton-guard.ts exists to
 * catch for the process registry. `SessionRoutes.admitAndStartGenerator`
 * (this PR's own refactor) calls `tryAdmitQuotaProbe` FOR REAL — unmocked —
 * on every fresh-start and parked-provider-switch path, so any test file
 * that drives `ensureGeneratorRunning` for real (this PR's
 * session-routes-provider-switch.test.ts) shares this singleton with every
 * other file in the same run that arms or claims it
 * (tests/worker/quota-cooldown.test.ts, tests/worker/overflow-recycle-resume.test.ts,
 * and any future file). A cooldown left armed, or a probe claim left
 * outstanding, by one of those files would silently gate every generator
 * start in this file for the rest of the process instead of failing loudly.
 *
 * Call this once at the file's TRUE TOP LEVEL — outside every describe() —
 * for the same LIFO-afterEach-ordering reason documented on
 * guardSharedProcessRegistrySingleton (process-registry-singleton-guard.ts):
 * only a hook registered outside every describe() block is guaranteed to run
 * its "after" check strictly after that file's own local cleanup, which must
 * stay nested one level in.
 *
 * The cmem gateway re-probe claim (provider-dispatch.ts) is the same shape of
 * process-wide admission state and is checked here too: a claim left held by
 * one test routes every later gateway dispatch in the process to 'claude'.
 */
export function guardSharedQuotaCooldownSingleton(label: string): void {
  const assertClean = (when: 'before' | 'after') => {
    const gatewayProbeClaim = getCmemGatewayProbeClaim();
    if (gatewayProbeClaim !== null) {
      throw new Error(
        `[quota-cooldown-singleton-guard:${label}] the cmem gateway re-probe claim ${gatewayProbeClaim} is still held ${when} a test. ` +
        `Some test took it through selectProviderForGenerator() and never released it; call ` +
        `resetCmemGatewayProbeForTesting() in its own afterEach rather than loosening this guard.`
      );
    }
    const armed = QUOTA_PROVIDERS
      .map(provider => ({ provider, state: getQuotaCooldown(provider) }))
      .filter(({ state }) => state !== null);
    if (armed.length > 0) {
      throw new Error(
        `[quota-cooldown-singleton-guard:${label}] shared quota-cooldown singleton is dirty ${when} a test — ` +
        `armed providers=${JSON.stringify(armed.map(({ provider, state }) => ({
          provider,
          probeInFlight: state!.probeInFlightSinceMs !== null,
          probeClaimId: state!.probeClaimId,
        })))}. ` +
        `Some test (possibly in a different file sharing this bun test process) left a quota cooldown armed or a ` +
        `probe claim outstanding instead of calling resetQuotaCooldownsForTesting() in its own afterEach/afterAll. ` +
        `Fix that leak rather than loosening this guard — a stale armed cooldown silently withholds every ` +
        `generator start for this provider in every later test in the same process.`
      );
    }
  };

  beforeEach(() => assertClean('before'));
  afterEach(() => assertClean('after'));
}
