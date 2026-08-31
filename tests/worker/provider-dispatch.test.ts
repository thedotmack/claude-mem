
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getSelectedProvider, recordCmemFallbackIfEligible } from '../../src/services/worker/provider-dispatch.js';
import { classifyOpenRouterError } from '../../src/services/worker/OpenRouterProvider.js';
import { cmemGatewayKeyHash, PRO_FALLBACK_PROBE_INTERVAL_MS } from '../../src/shared/cmem-gateway.js';

const CMEM_GATEWAY_BASE = 'https://cmem.ai/api/inference/v1';

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
  'CLAUDE_MEM_PRO_GATEWAY_BASE_URL',
  'CLAUDE_MEM_PRO_GATEWAY_KEY_HASH',
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
    process.env.CLAUDE_MEM_OPENROUTER_API_KEY = 'sk-or-test-key';
    process.env.CLAUDE_MEM_OPENROUTER_BASE_URL = CMEM_GATEWAY_BASE;
    process.env.CLAUDE_MEM_PRO_FALLBACK_AT = '';
    for (const [key, value] of Object.entries(overrides)) {
      process.env[key] = value;
    }
  }

  describe('getSelectedProvider', () => {
    it('returns openrouter when selected, keyed, and no fallback is recorded', () => {
      pinOpenRouterEnv();
      expect(getSelectedProvider()).toBe('openrouter');
    });

    it('returns claude when the fallback marker is set on a cmem-gateway config', () => {
      pinOpenRouterEnv({ CLAUDE_MEM_PRO_FALLBACK_AT: '2026-08-26T12:00:00.000Z' });
      expect(getSelectedProvider()).toBe('claude');
    });

    it('lets generator dispatch claim one recovery probe after the interval', () => {
      const tempDir = join(tmpdir(), `provider-probe-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      mkdirSync(tempDir, { recursive: true });
      const settingsPath = join(tempDir, 'settings.json');
      const nowMs = Date.parse('2026-08-26T12:00:00.000Z');
      writeFileSync(settingsPath, JSON.stringify({
        CLAUDE_MEM_PRO_FALLBACK_AT: new Date(nowMs - PRO_FALLBACK_PROBE_INTERVAL_MS).toISOString(),
      }));
      pinOpenRouterEnv();
      delete process.env.CLAUDE_MEM_PRO_FALLBACK_AT;

      try {
        // Status/read-only selection remains on the fallback provider.
        expect(getSelectedProvider({ settingsPath, nowMs })).toBe('claude');
        // Generator selection claims exactly one probe by refreshing the marker.
        expect(getSelectedProvider({ claimFallbackProbe: true, settingsPath, nowMs })).toBe('openrouter');
        expect(JSON.parse(readFileSync(settingsPath, 'utf-8')).CLAUDE_MEM_PRO_FALLBACK_AT)
          .toBe(new Date(nowMs).toISOString());
        expect(getSelectedProvider({ claimFallbackProbe: true, settingsPath, nowMs })).toBe('claude');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
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

    it('honors fallback for a custom browser-delivered gateway bound to the active key', () => {
      const customBaseUrl = 'https://memory.example.test/v1';
      pinOpenRouterEnv({
        CLAUDE_MEM_OPENROUTER_BASE_URL: customBaseUrl,
        CLAUDE_MEM_PRO_GATEWAY_BASE_URL: customBaseUrl,
        CLAUDE_MEM_PRO_GATEWAY_KEY_HASH: cmemGatewayKeyHash('sk-or-test-key'),
        CLAUDE_MEM_PRO_FALLBACK_AT: '2026-08-26T12:00:00.000Z',
      });
      expect(getSelectedProvider()).toBe('claude');

      process.env.CLAUDE_MEM_OPENROUTER_API_KEY = 'replacement-user-key';
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

      expect(recordCmemFallbackIfEligible(error, settingsPath)).toBe(true);

      const persisted = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(persisted.CLAUDE_MEM_PRO_FALLBACK_AT).not.toBe('');
      expect(Number.isNaN(Date.parse(persisted.CLAUDE_MEM_PRO_FALLBACK_AT))).toBe(false);
    });

    it('records the fallback for a key_invalid gateway rejection', () => {
      pinOpenRouterEnv();
      const error = gatewayError(401, 'key_invalid');
      expect(error.kind).toBe('auth_invalid');
      expect(error.code).toBe('key_invalid');

      expect(recordCmemFallbackIfEligible(error, settingsPath)).toBe(true);
    });

    it('records the fallback for a legacy (no-envelope) 402 on the gateway config', () => {
      pinOpenRouterEnv();
      const error = classifyOpenRouterError({
        status: 402,
        bodyText: 'Payment required',
        cause: new Error('upstream 402'),
      });
      expect(error.kind).toBe('quota_exhausted');

      expect(recordCmemFallbackIfEligible(error, settingsPath)).toBe(true);
    });

    it('never triggers for a user-owned openrouter.ai key running dry', () => {
      pinOpenRouterEnv({ CLAUDE_MEM_OPENROUTER_BASE_URL: '' });
      expect(recordCmemFallbackIfEligible(gatewayError(402, 'allowance_exhausted'), settingsPath)).toBe(false);

      pinOpenRouterEnv({ CLAUDE_MEM_OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1' });
      expect(recordCmemFallbackIfEligible(gatewayError(402, 'allowance_exhausted'), settingsPath)).toBe(false);
    });

    it('records fallback for a custom delivered gateway only while its bound key is active', () => {
      const customBaseUrl = 'https://memory.example.test/v1';
      pinOpenRouterEnv({
        CLAUDE_MEM_OPENROUTER_BASE_URL: customBaseUrl,
        CLAUDE_MEM_PRO_GATEWAY_BASE_URL: customBaseUrl,
        CLAUDE_MEM_PRO_GATEWAY_KEY_HASH: cmemGatewayKeyHash('sk-or-test-key'),
      });
      expect(recordCmemFallbackIfEligible(
        gatewayError(402, 'allowance_exhausted'),
        settingsPath,
      )).toBe(true);

      process.env.CLAUDE_MEM_OPENROUTER_API_KEY = 'replacement-user-key';
      expect(recordCmemFallbackIfEligible(
        gatewayError(402, 'allowance_exhausted'),
        settingsPath,
      )).toBe(false);
    });

    it('ignores non-terminal gateway errors (rate limits, transient, inactive subscription)', () => {
      pinOpenRouterEnv();
      expect(recordCmemFallbackIfEligible(gatewayError(429, 'rate_limited'), settingsPath)).toBe(false);
      expect(recordCmemFallbackIfEligible(gatewayError(503, 'upstream_unavailable'), settingsPath)).toBe(false);
      expect(recordCmemFallbackIfEligible(gatewayError(403, 'subscription_inactive'), settingsPath)).toBe(false);
    });
  });
});
