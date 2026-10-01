
import { describe, it, expect, beforeEach, afterEach, afterAll, setSystemTime, spyOn } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  CMEM_FALLBACK_RETRY_MS,
  getSelectedProvider,
  quotaFallbackTarget,
  recordCmemFallbackIfEligible,
  releaseCmemGatewayProbe,
  resetQuotaFallbackStateForTesting,
  selectProviderForGenerator,
  shouldUseCmemFallback,
  type ProviderSelection,
} from '../../src/services/worker/provider-dispatch.js';
import { classifyOpenRouterError } from '../../src/services/worker/OpenRouterProvider.js';
import {
  QUOTA_COOLDOWN_FILENAME,
  QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS,
  QUOTA_PROBE_STALE_MS,
  RATE_LIMIT_RECHECK_COOLDOWN_MS,
  clearQuotaCooldown,
  recordAuthCooldown,
  recordQuotaExhausted,
  resetQuotaCooldownsForTesting,
  tryAdmitQuotaProbe,
} from '../../src/shared/quota-cooldown.js';
import { isCmemGatewayUrl } from '../../src/shared/cmem-gateway.js';
import { paths } from '../../src/shared/paths.js';
import { logger } from '../../src/utils/logger.js';
import {
  OBSERVER_HEALTH_FILENAME,
  readObserverHealth,
  renderObserverQuotaCooldownNotice,
} from '../../src/shared/observer-health.js';

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
  'CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER',
  'CLAUDE_MEM_QUOTA_FALLBACK_MODEL',
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
      // The full quota cooldown: a rate limit's short window cannot outlive
      // the fallback window.
      recordQuotaExhausted('openrouter', 'spend cap reached', undefined, armedAt);

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
  describe('quota fallback dispatch', () => {
    const expired = (): number => Date.now() - QUOTA_EXHAUSTED_RECHECK_COOLDOWN_MS - 1;
    let lines: string[];
    let spies: Array<ReturnType<typeof spyOn>>;

    function pinGeminiPrimary(fallback: string, overrides: Record<string, string> = {}): void {
      process.env.CLAUDE_MEM_PROVIDER = 'gemini';
      process.env.CLAUDE_MEM_GEMINI_API_KEY = 'gemini-test-key';
      process.env.CLAUDE_MEM_OPENROUTER_API_KEY = '';
      process.env.CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER = fallback;
      for (const [key, value] of Object.entries(overrides)) {
        process.env[key] = value;
      }
    }

    /** Only the quota-fallback transition lines, in the order they were logged. */
    function quotaFallbackLines(): string[] {
      return lines.filter(message => message.startsWith('Primary '));
    }

    beforeEach(() => {
      resetQuotaCooldownsForTesting();
      resetQuotaFallbackStateForTesting();
      lines = [];
      spies = [
        spyOn(logger, 'warn').mockImplementation((_component: string, message: string) => { lines.push(message); }),
        spyOn(logger, 'info').mockImplementation((_component: string, message: string) => { lines.push(message); }),
      ];
    });

    afterEach(() => {
      spies.forEach(spy => spy.mockRestore());
      resetQuotaCooldownsForTesting();
      resetQuotaFallbackStateForTesting();
    });

    // The breaker is process-global; a window left armed here would gate
    // generator starts in every later file of the same bun process.
    afterAll(() => {
      resetQuotaCooldownsForTesting();
    });

    it('with no fallback configured, every primary is unchanged', () => {
      const primaries = [
        ['gemini', { CLAUDE_MEM_PROVIDER: 'gemini', CLAUDE_MEM_GEMINI_API_KEY: 'gemini-test-key', CLAUDE_MEM_OPENROUTER_API_KEY: '' }],
        ['openrouter', { CLAUDE_MEM_PROVIDER: 'openrouter', CLAUDE_MEM_OPENROUTER_API_KEY: PERSONAL_KEY, CLAUDE_MEM_OPENROUTER_BASE_URL: '' }],
        ['claude', { CLAUDE_MEM_PROVIDER: 'claude', CLAUDE_MEM_GEMINI_API_KEY: '', CLAUDE_MEM_OPENROUTER_API_KEY: '' }],
      ] as const;
      for (const [provider, env] of primaries) {
        Object.assign(process.env, env, { CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER: '' });
        recordQuotaExhausted(provider, 'Allowance spent');
        expect(selectProviderForGenerator()).toEqual({ provider, gatewayProbeClaimId: null });
        expect(getSelectedProvider()).toBe(provider);
      }
      expect(quotaFallbackLines()).toEqual([]);
    });

    it('routes a holding primary to the fallback, naming what it stands in for', () => {
      pinGeminiPrimary('claude');
      recordQuotaExhausted('gemini', 'Daily limit reached');
      expect(selectProviderForGenerator()).toEqual({ provider: 'claude', gatewayProbeClaimId: null, fallbackFrom: 'gemini' });
      expect(getSelectedProvider()).toBe('claude');
    });

    it('holds a rate-limit window only for the short throttle cooldown', () => {
      pinGeminiPrimary('claude');
      const armedAt = Date.now() - RATE_LIMIT_RECHECK_COOLDOWN_MS - 1;
      recordQuotaExhausted('gemini', 'Provider rate limited the request', 'rate_limit', armedAt);
      expect(selectProviderForGenerator().provider).toBe('gemini');
    });

    it('does not route around a refused credential: the key is the problem, not the quota', () => {
      pinGeminiPrimary('claude');
      recordAuthCooldown('gemini', 'API key not valid');
      expect(selectProviderForGenerator()).toEqual({ provider: 'gemini', gatewayProbeClaimId: null });
      expect(quotaFallbackLines()).toEqual([]);
    });

    it('skips a fallback whose own key was refused', () => {
      pinGeminiPrimary('openrouter', { CLAUDE_MEM_OPENROUTER_API_KEY: PERSONAL_KEY, CLAUDE_MEM_OPENROUTER_BASE_URL: '' });
      recordAuthCooldown('openrouter', 'User not found');
      recordQuotaExhausted('gemini', 'Daily limit reached');
      expect(selectProviderForGenerator().provider).toBe('gemini');
    });

    it('never sends a fallback to the cmem gateway while it is turning the account away', () => {
      pinGeminiPrimary('openrouter', {
        CLAUDE_MEM_OPENROUTER_BASE_URL: CMEM_GATEWAY_BASE,
        CLAUDE_MEM_OPENROUTER_API_KEY: CMEM_MEMORY_KEY,
        CLAUDE_MEM_PRO_FALLBACK_AT: new Date(Date.now() - 2 * CMEM_FALLBACK_RETRY_MS).toISOString(),
      });
      recordQuotaExhausted('gemini', 'Daily limit reached');
      expect(selectProviderForGenerator().provider).toBe('gemini');
      // With the gateway serving the account again, it is a fallback like any other.
      process.env.CLAUDE_MEM_PRO_FALLBACK_AT = '';
      expect(selectProviderForGenerator()).toEqual({ provider: 'openrouter', gatewayProbeClaimId: null, fallbackFrom: 'gemini' });
    });

    it('returns the primary once its window elapses with no probe in flight, so it can claim the probe', () => {
      pinGeminiPrimary('claude');
      recordQuotaExhausted('gemini', 'Daily limit reached', undefined, expired());
      expect(selectProviderForGenerator().provider).toBe('gemini');
    });

    it('keeps using the fallback while the primary probe is in flight', () => {
      pinGeminiPrimary('claude');
      recordQuotaExhausted('gemini', 'Daily limit reached', undefined, expired());
      expect(tryAdmitQuotaProbe('gemini').admitted).toBe(true);
      expect(selectProviderForGenerator().provider).toBe('claude');
    });

    it('returns the primary once that probe goes stale', () => {
      pinGeminiPrimary('claude');
      recordQuotaExhausted('gemini', 'Daily limit reached', undefined, expired() - QUOTA_PROBE_STALE_MS);
      expect(tryAdmitQuotaProbe('gemini', Date.now() - QUOTA_PROBE_STALE_MS - 1).admitted).toBe(true);
      expect(selectProviderForGenerator().provider).toBe('gemini');
    });

    it('stays on the primary when the fallback has no credentials', () => {
      pinGeminiPrimary('openrouter', { CLAUDE_MEM_OPENROUTER_API_KEY: '' });
      recordQuotaExhausted('gemini', 'Daily limit reached');
      expect(selectProviderForGenerator().provider).toBe('gemini');
    });

    it('stays on the primary when the fallback is itself holding (both exhausted)', () => {
      pinGeminiPrimary('claude');
      recordQuotaExhausted('claude', 'Weekly limit reached', 'seven_day');
      recordQuotaExhausted('gemini', 'Daily limit reached');
      expect(selectProviderForGenerator()).toEqual({ provider: 'gemini', gatewayProbeClaimId: null });
    });

    it('ignores a fallback equal to the primary', () => {
      pinGeminiPrimary('gemini');
      recordQuotaExhausted('gemini', 'Daily limit reached');
      expect(selectProviderForGenerator().provider).toBe('gemini');
    });

    it('treats an unrecognised fallback value as off, and tolerates surrounding spaces', () => {
      pinGeminiPrimary('anthropic');
      recordQuotaExhausted('gemini', 'Daily limit reached');
      expect(selectProviderForGenerator().provider).toBe('gemini');
      process.env.CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER = ' claude ';
      expect(selectProviderForGenerator().provider).toBe('claude');
    });

    it('routes to the fallback on the first dispatch after a worker restart', () => {
      pinGeminiPrimary('claude');
      mkdirSync(paths.dataDir(), { recursive: true });
      writeFileSync(
        join(paths.dataDir(), QUOTA_COOLDOWN_FILENAME),
        JSON.stringify([{ provider: 'gemini', message: 'armed before the restart', armedAtMs: Date.now() - 60_000 }]),
      );
      expect(selectProviderForGenerator().provider).toBe('claude');
    });

    it('leaves the cmem-gateway fallback branch untouched', () => {
      pinOpenRouterEnv({ CLAUDE_MEM_PRO_FALLBACK_AT: new Date().toISOString() });
      process.env.CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER = 'gemini';
      process.env.CLAUDE_MEM_GEMINI_API_KEY = 'gemini-test-key';
      recordQuotaExhausted('claude', 'Weekly limit reached');
      expect(selectProviderForGenerator()).toEqual({ provider: 'claude', gatewayProbeClaimId: null });
      expect(getSelectedProvider()).toBe('claude');
    });

    it('getSelectedProvider agrees with selectProviderForGenerator in every case', () => {
      pinGeminiPrimary('claude');
      const arrangements: Array<() => void> = [
        () => {},
        () => { recordQuotaExhausted('gemini', 'Daily limit reached'); },
        () => { recordQuotaExhausted('gemini', 'Daily limit reached', undefined, expired()); },
        () => {
          recordQuotaExhausted('gemini', 'Daily limit reached', undefined, expired());
          tryAdmitQuotaProbe('gemini');
        },
        () => {
          recordQuotaExhausted('claude', 'Weekly limit reached');
          recordQuotaExhausted('gemini', 'Daily limit reached');
        },
      ];
      for (const arrange of arrangements) {
        resetQuotaCooldownsForTesting();
        arrange();
        expect(getSelectedProvider()).toBe(selectProviderForGenerator().provider);
      }
    });

    it('logs each quota-fallback state change once, not per dispatch', () => {
      pinGeminiPrimary('claude');
      selectProviderForGenerator(); // healthy: silent
      recordQuotaExhausted('gemini', 'Daily limit reached');
      selectProviderForGenerator();
      selectProviderForGenerator(); // still on the fallback: silent
      recordQuotaExhausted('gemini', 'Daily limit reached', undefined, expired());
      selectProviderForGenerator(); // window elapsed: probing
      clearQuotaCooldown('gemini');
      selectProviderForGenerator(); // the probe succeeded and cleared the breaker
      expect(quotaFallbackLines()).toEqual([
        'Primary in quota cooldown; dispatching to fallback',
        'Primary quota cooldown elapsed; probing primary',
        'Primary recovered from quota cooldown',
      ]);
    });

    it('names the both-exhausted state instead of calling it a probe', () => {
      pinGeminiPrimary('claude');
      recordQuotaExhausted('claude', 'Weekly limit reached');
      recordQuotaExhausted('gemini', 'Daily limit reached');
      selectProviderForGenerator();
      selectProviderForGenerator();
      expect(quotaFallbackLines()).toEqual(['Primary and fallback both in quota cooldown; capture waits until one clears']);
    });

    it('does not claim both are exhausted when the fallback simply cannot serve', () => {
      pinGeminiPrimary('openrouter', { CLAUDE_MEM_OPENROUTER_API_KEY: '' });
      recordQuotaExhausted('gemini', 'Daily limit reached');
      selectProviderForGenerator();
      expect(quotaFallbackLines()).toEqual(['Primary in quota cooldown and the quota fallback cannot serve; capture waits until it clears']);
    });

    it('mirrors the serving fallback for the session-start notice', () => {
      pinGeminiPrimary('claude');
      recordQuotaExhausted('gemini', 'Daily limit reached');
      const mirrored = readObserverHealth(join(paths.dataDir(), OBSERVER_HEALTH_FILENAME))!.quotaCooldown!;
      expect(mirrored.servingProvider).toBe('claude');
    });

    it('mirrors no serving provider when no fallback is configured', () => {
      pinGeminiPrimary('');
      recordQuotaExhausted('gemini', 'Daily limit reached');
      const mirrored = readObserverHealth(join(paths.dataDir(), OBSERVER_HEALTH_FILENAME))!.quotaCooldown!;
      expect(mirrored.servingProvider).toBeUndefined();
    });

    it('names the recovered primary once the fallback holds and the primary clears', () => {
      // The mirror shows the longest pause. Once the fallback has armed its
      // own and the primary's probe then succeeds, the held provider IS the
      // fallback and capture is back on the primary: no "paused" notice.
      const healthFile = join(paths.dataDir(), OBSERVER_HEALTH_FILENAME);
      pinGeminiPrimary('claude');
      recordQuotaExhausted('gemini', 'Daily limit reached', undefined, Date.now() - 1000);
      recordQuotaExhausted('claude', 'Weekly limit reached');
      expect(readObserverHealth(healthFile)!.quotaCooldown!.servingProvider).toBeUndefined(); // both held
      clearQuotaCooldown('gemini');
      const mirrored = readObserverHealth(healthFile)!.quotaCooldown!;
      expect(mirrored.provider).toBe('claude');
      expect(mirrored.servingProvider).toBe('gemini');
      expect(renderObserverQuotaCooldownNotice(readObserverHealth(healthFile)!)).not.toMatch(/paused|restart/i);
    });

    it('never offers a provider as its own fallback', () => {
      pinGeminiPrimary('claude');
      expect(quotaFallbackTarget('gemini')).toBe('claude');
      expect(quotaFallbackTarget('claude')).toBeNull();
    });
  });
});
