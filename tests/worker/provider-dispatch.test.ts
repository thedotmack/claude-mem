
import { describe, it, expect, beforeEach, afterEach, setSystemTime } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  CMEM_FALLBACK_RETRY_MS,
  getSelectedProvider,
  recordCmemFallbackIfEligible,
  releaseCmemGatewayProbe,
  selectProviderForGenerator,
  shouldUseCmemFallback,
  type ProviderSelection,
} from '../../src/services/worker/provider-dispatch.js';
import { classifyOpenRouterError } from '../../src/services/worker/OpenRouterProvider.js';
import {
  QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS,
  QUOTA_PROBE_STALE_MS,
  recordQuotaExhausted,
  resetQuotaCooldownsForTesting,
} from '../../src/shared/quota-cooldown.js';
import { isCmemGatewayUrl } from '../../src/shared/cmem-gateway.js';

const CMEM_GATEWAY_BASE = 'https://cmem.ai/api/inference/v1';
const CMEM_MEMORY_KEY = 'cm_pro_0123456789abcdef01234567';
const PERSONAL_KEY = 'sk-or-test-key';

/**
 * The dispatch predicates read settings via SettingsDefaultsManager, which
 * applies process.env overrides LAST — so pinning env vars (empty string
 * included) fully controls the outcome regardless of the temp data dir's
 * settings file. Preload (tests/preload.ts) already pins CLAUDE_MEM_DATA_DIR
 * to a per-run temp dir, so no real ~/.claude-mem I/O happens here.
 */
const ENV_KEYS = [
  'CLAUDE_MEM_PROVIDER',
  'CLAUDE_MEM_OPENROUTER_API_KEY',
  'CLAUDE_MEM_OPENROUTER_BASE_URL',
  'CLAUDE_MEM_PRO_FALLBACK_AT',
  'CLAUDE_MEM_GEMINI_API_KEY',
  'CMEM_PRO_ORIGIN',
] as const;

describe('provider-dispatch', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  function pinOpenRouterEnv(overrides: Record<string, string> = {}): void {
    process.env.CLAUDE_MEM_PROVIDER = 'openrouter';
    process.env.CLAUDE_MEM_OPENROUTER_BASE_URL = CMEM_GATEWAY_BASE;
    process.env.CLAUDE_MEM_PRO_FALLBACK_AT = '';
    for (const [key, value] of Object.entries(overrides)) {
      process.env[key] = value;
    }
    // Each endpoint with its own kind of key: the cmem memory key only goes to
    // the gateway, and the gateway only takes a cmem memory key.
    if (!('CLAUDE_MEM_OPENROUTER_API_KEY' in overrides)) {
      process.env.CLAUDE_MEM_OPENROUTER_API_KEY = isCmemGatewayUrl(process.env.CLAUDE_MEM_OPENROUTER_BASE_URL)
        ? CMEM_MEMORY_KEY
        : PERSONAL_KEY;
    }
  }

  describe('getSelectedProvider', () => {
    it('returns openrouter when selected, keyed, and no fallback is recorded', () => {
      pinOpenRouterEnv();
      expect(getSelectedProvider()).toBe('openrouter');
    });

    it('returns claude when the fallback marker is set on a cmem-gateway config', () => {
      pinOpenRouterEnv({ CLAUDE_MEM_PRO_FALLBACK_AT: new Date().toISOString() });
      expect(getSelectedProvider()).toBe('claude');
    });

    it('allows a gateway recovery probe after the fallback cooldown', () => {
      pinOpenRouterEnv({
        CLAUDE_MEM_PRO_FALLBACK_AT: new Date(Date.now() - CMEM_FALLBACK_RETRY_MS - 1).toISOString(),
      });
      expect(getSelectedProvider()).toBe('openrouter');
    });

    it('ignores the fallback marker entirely for a user-owned openrouter.ai key', () => {
      pinOpenRouterEnv({
        CLAUDE_MEM_OPENROUTER_BASE_URL: '',
        CLAUDE_MEM_PRO_FALLBACK_AT: '2026-08-26T12:00:00.000Z',
      });
      expect(getSelectedProvider()).toBe('openrouter');

      pinOpenRouterEnv({
        CLAUDE_MEM_OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
        CLAUDE_MEM_PRO_FALLBACK_AT: '2026-08-26T12:00:00.000Z',
      });
      expect(getSelectedProvider()).toBe('openrouter');
    });

    it('ignores the fallback marker for deceptive cmem.ai hostname prefixes', () => {
      pinOpenRouterEnv({
        CLAUDE_MEM_OPENROUTER_BASE_URL: 'https://cmem.ai.evil.example/api/inference/v1',
        CLAUDE_MEM_PRO_FALLBACK_AT: '2026-08-26T12:00:00.000Z',
      });
      expect(getSelectedProvider()).toBe('openrouter');
    });

    it('falls through to claude when openrouter is selected but has no key', () => {
      pinOpenRouterEnv({ CLAUDE_MEM_OPENROUTER_API_KEY: '' });
      expect(getSelectedProvider()).toBe('claude');
    });

    it('returns claude for the default provider selection', () => {
      process.env.CLAUDE_MEM_PROVIDER = 'claude';
      process.env.CLAUDE_MEM_GEMINI_API_KEY = '';
      process.env.CLAUDE_MEM_OPENROUTER_API_KEY = '';
      expect(getSelectedProvider()).toBe('claude');
    });
  });

  describe('selectProviderForGenerator — the single gateway re-probe', () => {
    // The claim is process-wide state: never let one test's claim reach the next.
    afterEach(() => {
      setSystemTime();
      resetQuotaCooldownsForTesting();
    });

    const select = (): ProviderSelection => selectProviderForGenerator();

    function elapsedFallbackAt(): string {
      return new Date(Date.now() - CMEM_FALLBACK_RETRY_MS - 1_000).toISOString();
    }

    it('keeps every caller on claude, claim-free, while the fallback window is fresh', () => {
      pinOpenRouterEnv({ CLAUDE_MEM_PRO_FALLBACK_AT: new Date().toISOString() });
      const selections = Array.from({ length: 5 }, select);
      expect(selections).toEqual(Array.from({ length: 5 }, () => ({ provider: 'claude', gatewayProbeClaimId: null })));
    });

    it('admits exactly one of N concurrent callers once the window elapses', () => {
      pinOpenRouterEnv({ CLAUDE_MEM_PRO_FALLBACK_AT: elapsedFallbackAt() });
      const selections = Array.from({ length: 10 }, select);

      const probes = selections.filter(selection => selection.provider === 'openrouter');
      expect(probes).toHaveLength(1);
      expect(probes[0].gatewayProbeClaimId).not.toBeNull();
      expect(selections.filter(selection => selection.provider === 'claude')).toHaveLength(9);
    });

    it('re-admits a caller only after the probe releases its own claim', () => {
      pinOpenRouterEnv({ CLAUDE_MEM_PRO_FALLBACK_AT: elapsedFallbackAt() });
      const probe = select();
      expect(probe.provider).toBe('openrouter');
      expect(probe.gatewayProbeClaimId).not.toBeNull();

      // A claim-free run and a foreign claim id release nothing.
      releaseCmemGatewayProbe(null);
      releaseCmemGatewayProbe((probe.gatewayProbeClaimId ?? 0) + 1_000);
      expect(select().provider).toBe('claude');

      releaseCmemGatewayProbe(probe.gatewayProbeClaimId);
      const next = select();
      expect(next.provider).toBe('openrouter');
      expect(next.gatewayProbeClaimId).not.toBe(probe.gatewayProbeClaimId);
    });

    it('lets a stale probe be taken over, so a lost claim cannot wedge the gateway shut', () => {
      pinOpenRouterEnv({ CLAUDE_MEM_PRO_FALLBACK_AT: elapsedFallbackAt() });
      const probe = select();
      expect(probe.provider).toBe('openrouter');

      setSystemTime(new Date(Date.now() + QUOTA_PROBE_STALE_MS + 1_000));
      const takeover = select();
      expect(takeover.provider).toBe('openrouter');
      expect(takeover.gatewayProbeClaimId).not.toBe(probe.gatewayProbeClaimId);

      // The abandoned owner's late release leaves the new claim alone.
      releaseCmemGatewayProbe(probe.gatewayProbeClaimId);
      expect(select().provider).toBe('claude');
    });

    it('stays on claude, claim-free, while an openrouter breaker outlives the fallback window, then probes', () => {
      pinOpenRouterEnv({ CLAUDE_MEM_PRO_FALLBACK_AT: elapsedFallbackAt() });
      // The start gate would refuse any gateway run while this breaker is live.
      const armedAt = Date.now() - 20 * 60_000;
      recordQuotaExhausted('openrouter', 'rate limited', 'rate_limit', armedAt);

      expect(select()).toEqual({ provider: 'claude', gatewayProbeClaimId: null });
      expect(getSelectedProvider()).toBe('claude');

      // Once the breaker's own window elapses, the single re-probe goes out.
      setSystemTime(new Date(armedAt + QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS + 1_000));
      const probe = select();
      expect(probe.provider).toBe('openrouter');
      expect(probe.gatewayProbeClaimId).not.toBeNull();
    });

    it('takes no claim for a user-owned openrouter.ai key', () => {
      pinOpenRouterEnv({
        CLAUDE_MEM_OPENROUTER_BASE_URL: '',
        CLAUDE_MEM_PRO_FALLBACK_AT: elapsedFallbackAt(),
      });
      expect(Array.from({ length: 3 }, select)).toEqual(
        Array.from({ length: 3 }, () => ({ provider: 'openrouter', gatewayProbeClaimId: null })),
      );
    });
  });

  describe('shouldUseCmemFallback', () => {
    const now = Date.parse('2026-08-26T12:30:00.000Z');

    it('uses Claude during the cooldown and probes once it expires', () => {
      expect(shouldUseCmemFallback('2026-08-26T12:29:00.000Z', now)).toBe(true);
      expect(shouldUseCmemFallback(
        new Date(now - CMEM_FALLBACK_RETRY_MS).toISOString(),
        now,
      )).toBe(false);
    });

    it('keeps malformed non-empty markers safely fallen back', () => {
      expect(shouldUseCmemFallback('not-an-iso-date', now)).toBe(true);
      expect(shouldUseCmemFallback('', now)).toBe(false);
    });
  });

  describe('recordCmemFallbackIfEligible', () => {
    let tempDir: string;
    let settingsPath: string;

    beforeEach(() => {
      tempDir = join(tmpdir(), `provider-dispatch-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      mkdirSync(tempDir, { recursive: true });
      settingsPath = join(tempDir, 'settings.json');
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    function gatewayError(status: number, code: string): ReturnType<typeof classifyOpenRouterError> {
      return classifyOpenRouterError({
        status,
        bodyText: JSON.stringify({ error: { code, message: `gateway said ${code}` } }),
        cause: new Error(`upstream ${status}`),
      });
    }

    it('records the fallback for a 402 allowance_exhausted from the cmem gateway', () => {
      pinOpenRouterEnv();
      const error = gatewayError(402, 'allowance_exhausted');
      expect(error.kind).toBe('quota_exhausted');

      expect(recordCmemFallbackIfEligible(error, null, settingsPath)).toBe(true);

      const persisted = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(persisted.CLAUDE_MEM_PRO_FALLBACK_AT).not.toBe('');
      expect(Number.isNaN(Date.parse(persisted.CLAUDE_MEM_PRO_FALLBACK_AT))).toBe(false);
    });

    it('stores the gateway\'s own message and link with the marker, for the session-start notice', () => {
      pinOpenRouterEnv();
      const error = classifyOpenRouterError({
        status: 402,
        bodyText: JSON.stringify({ error: {
          code: 'allowance_exhausted',
          message: "You've used your $30 CMEM Pro inference allowance for this billing cycle.",
          action: 'It resets at the start of your next billing cycle.',
          url: 'https://cmem.ai/dashboard',
          request_id: 'req_1',
        } }),
        cause: new Error('upstream 402'),
      });

      expect(recordCmemFallbackIfEligible(error, null, settingsPath)).toBe(true);

      const persisted = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(persisted.CLAUDE_MEM_PRO_FALLBACK_MESSAGE).toBe("You've used your $30 CMEM Pro inference allowance for this billing cycle.");
      expect(persisted.CLAUDE_MEM_PRO_FALLBACK_ACTION).toBe('It resets at the start of your next billing cycle.');
      expect(persisted.CLAUDE_MEM_PRO_FALLBACK_URL).toBe('https://cmem.ai/dashboard');
    });

    it('stores no words for a legacy (no-envelope) 402, so the notice stays plan-neutral', () => {
      pinOpenRouterEnv();
      writeFileSync(settingsPath, JSON.stringify({
        CLAUDE_MEM_PRO_FALLBACK_MESSAGE: 'stale words from an earlier fallback',
        CLAUDE_MEM_PRO_FALLBACK_ACTION: 'stale action',
        CLAUDE_MEM_PRO_FALLBACK_URL: 'https://cmem.ai/stale',
      }));
      const error = classifyOpenRouterError({ status: 402, bodyText: 'Payment required', cause: new Error('upstream 402') });

      expect(recordCmemFallbackIfEligible(error, null, settingsPath)).toBe(true);

      const persisted = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(persisted.CLAUDE_MEM_PRO_FALLBACK_MESSAGE).toBe('');
      expect(persisted.CLAUDE_MEM_PRO_FALLBACK_ACTION).toBe('');
      expect(persisted.CLAUDE_MEM_PRO_FALLBACK_URL).toBe('');
    });

    it('does not rewrite the marker while the fallback window is already running', () => {
      const armedAt = new Date(Date.now() - 60_000).toISOString();
      pinOpenRouterEnv();
      delete process.env.CLAUDE_MEM_PRO_FALLBACK_AT;
      writeFileSync(settingsPath, JSON.stringify({ CLAUDE_MEM_PRO_FALLBACK_AT: armedAt }));

      // Consumed as handled — another generator's rejection already switched it.
      expect(recordCmemFallbackIfEligible(gatewayError(402, 'allowance_exhausted'), null, settingsPath)).toBe(true);
      expect(JSON.parse(readFileSync(settingsPath, 'utf-8')).CLAUDE_MEM_PRO_FALLBACK_AT).toBe(armedAt);
    });

    it('records the fallback for a key_invalid gateway rejection', () => {
      pinOpenRouterEnv();
      const error = gatewayError(401, 'key_invalid');
      expect(error.kind).toBe('auth_invalid');
      expect(error.code).toBe('key_invalid');

      expect(recordCmemFallbackIfEligible(error, null, settingsPath)).toBe(true);
    });

    it('records the fallback for a legacy (no-envelope) 402 on the gateway config', () => {
      pinOpenRouterEnv();
      const error = classifyOpenRouterError({
        status: 402,
        bodyText: 'Payment required',
        cause: new Error('upstream 402'),
      });
      expect(error.kind).toBe('quota_exhausted');

      expect(recordCmemFallbackIfEligible(error, null, settingsPath)).toBe(true);
    });

    it('never triggers for a user-owned openrouter.ai key running dry', () => {
      pinOpenRouterEnv({ CLAUDE_MEM_OPENROUTER_BASE_URL: '' });
      expect(recordCmemFallbackIfEligible(gatewayError(402, 'allowance_exhausted'), null, settingsPath)).toBe(false);

      pinOpenRouterEnv({ CLAUDE_MEM_OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1' });
      expect(recordCmemFallbackIfEligible(gatewayError(402, 'allowance_exhausted'), null, settingsPath)).toBe(false);
    });

    it('never triggers for deceptive cmem.ai hostname prefixes', () => {
      pinOpenRouterEnv({
        CLAUDE_MEM_OPENROUTER_BASE_URL: 'https://cmem.ai.evil.example/api/inference/v1',
      });
      expect(recordCmemFallbackIfEligible(gatewayError(402, 'allowance_exhausted'), null, settingsPath)).toBe(false);
      const persisted = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(persisted.CLAUDE_MEM_PRO_FALLBACK_AT).toBe('');
    });

    it('records the fallback for subscription_inactive — a lapsed, cancelled, or unpaid trial', () => {
      pinOpenRouterEnv();
      const error = gatewayError(402, 'subscription_inactive');
      expect(error.kind).toBe('auth_invalid');

      expect(recordCmemFallbackIfEligible(error, null, settingsPath)).toBe(true);
      expect(JSON.parse(readFileSync(settingsPath, 'utf-8')).CLAUDE_MEM_PRO_FALLBACK_AT).not.toBe('');
    });

    it.each([401, 403])('records the fallback for a %i the gateway sent without an envelope (an edge or WAF page)', (status) => {
      pinOpenRouterEnv();
      const error = classifyOpenRouterError({ status, bodyText: '<html>Access denied</html>', cause: new Error(`upstream ${status}`) });
      expect(error.kind).toBe('auth_invalid');
      expect(error.code).toBeUndefined();

      expect(recordCmemFallbackIfEligible(error, null, settingsPath)).toBe(true);
      expect(JSON.parse(readFileSync(settingsPath, 'utf-8')).CLAUDE_MEM_PRO_FALLBACK_AT).not.toBe('');
    });

    it('ignores non-terminal gateway errors (rate limits, transient upstream failures)', () => {
      pinOpenRouterEnv();
      expect(recordCmemFallbackIfEligible(gatewayError(429, 'rate_limited'), null, settingsPath)).toBe(false);
      expect(recordCmemFallbackIfEligible(gatewayError(503, 'upstream_unavailable'), null, settingsPath)).toBe(false);
    });
  });
});
