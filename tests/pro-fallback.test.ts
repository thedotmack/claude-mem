import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  activateFallback,
  clearFallback,
  isCmemProBaseUrl,
  isFallbackActive,
  isProFallbackHoldActive,
  readProFallbackState,
  resolveFallbackProvider,
  PRO_FALLBACK_PROBE_INTERVAL_MS,
  PRO_FALLBACK_TTL_MS,
} from '../src/shared/pro-fallback.js';
import { isProFallbackGatewayCode } from '../src/services/worker/OpenRouterProvider.js';

describe('pro-fallback state file', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'claude-mem-pro-fallback-'));
    filePath = join(dir, 'pro-fallback.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is inactive when no state file exists', () => {
    expect(isFallbackActive(filePath)).toBe(false);
    expect(readProFallbackState(filePath)).toBeNull();
  });

  it('activateFallback writes {active, reason, activatedAt} and isFallbackActive reads true', () => {
    const now = Date.now();
    activateFallback('allowance_exhausted', filePath, now);
    const state = readProFallbackState(filePath);
    expect(state).not.toBeNull();
    expect(state!.active).toBe(true);
    expect(state!.reason).toBe('allowance_exhausted');
    expect(state!.activatedAt).toBe(new Date(now).toISOString());
    expect(isFallbackActive(filePath, now)).toBe(true);
  });

  it('creates the parent directory when missing', () => {
    const nested = join(dir, 'deeper', 'pro-fallback.json');
    activateFallback('subscription_inactive', nested);
    expect(isFallbackActive(nested)).toBe(true);
  });

  it('clearFallback removes the state (and tolerates a missing file)', () => {
    activateFallback('allowance_exhausted', filePath);
    clearFallback(filePath);
    expect(existsSync(filePath)).toBe(false);
    expect(isFallbackActive(filePath)).toBe(false);
    // Second clear on a missing file must not throw.
    clearFallback(filePath);
  });

  it('stays active just inside the 24h TTL', () => {
    const activated = Date.now();
    activateFallback('allowance_exhausted', filePath, activated);
    expect(isFallbackActive(filePath, activated + PRO_FALLBACK_TTL_MS - 1)).toBe(true);
  });

  it('self-clears past the 24h TTL so Pro is retried', () => {
    const activated = Date.now();
    activateFallback('allowance_exhausted', filePath, activated);
    expect(isFallbackActive(filePath, activated + PRO_FALLBACK_TTL_MS + 1)).toBe(false);
    // The expired marker was deleted on read — the self-heal.
    expect(existsSync(filePath)).toBe(false);
    // A fresh definitive failure re-activates.
    activateFallback('allowance_exhausted', filePath);
    expect(isFallbackActive(filePath)).toBe(true);
  });

  it('treats a malformed or unparseable activatedAt as expired and self-clears', () => {
    writeFileSync(filePath, JSON.stringify({ active: true, reason: 'x', activatedAt: 'not-a-date' }));
    expect(isFallbackActive(filePath)).toBe(false);
    expect(existsSync(filePath)).toBe(false);
  });

  it('reads malformed JSON as inactive without throwing', () => {
    writeFileSync(filePath, '{not json');
    expect(readProFallbackState(filePath)).toBeNull();
    expect(isFallbackActive(filePath)).toBe(false);
  });

  it('reads {active: false} as inactive without clearing', () => {
    writeFileSync(filePath, JSON.stringify({ active: false, reason: '', activatedAt: new Date().toISOString() }));
    expect(isFallbackActive(filePath)).toBe(false);
    expect(existsSync(filePath)).toBe(true);
  });
});

describe('isProFallbackHoldActive (no-usable-fallback dispatch hold)', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'claude-mem-pro-hold-'));
    filePath = join(dir, 'pro-fallback.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is inactive when no marker exists', () => {
    expect(isProFallbackHoldActive(filePath)).toBe(false);
  });

  it('holds while the marker is fresher than the probe interval', () => {
    const now = Date.now();
    activateFallback('allowance_exhausted', filePath, now);
    expect(isProFallbackHoldActive(filePath, now)).toBe(true);
    expect(isProFallbackHoldActive(filePath, now + PRO_FALLBACK_PROBE_INTERVAL_MS - 1)).toBe(true);
  });

  it('lifts after the probe interval while the marker itself stays active', () => {
    const now = Date.now();
    activateFallback('allowance_exhausted', filePath, now);
    const probeTime = now + PRO_FALLBACK_PROBE_INTERVAL_MS + 1;
    expect(isProFallbackHoldActive(filePath, probeTime)).toBe(false);
    // The 24h fallback marker is still on — only the dispatch hold lifted.
    expect(isFallbackActive(filePath, probeTime)).toBe(true);
  });

  it('re-arms when a failed probe re-writes the marker', () => {
    const now = Date.now();
    activateFallback('allowance_exhausted', filePath, now);
    const probeTime = now + PRO_FALLBACK_PROBE_INTERVAL_MS + 1;
    expect(isProFallbackHoldActive(filePath, probeTime)).toBe(false);
    activateFallback('allowance_exhausted', filePath, probeTime);
    expect(isProFallbackHoldActive(filePath, probeTime)).toBe(true);
  });

  it('is inactive past the 24h TTL (marker self-clears)', () => {
    const now = Date.now();
    activateFallback('allowance_exhausted', filePath, now);
    expect(isProFallbackHoldActive(filePath, now + PRO_FALLBACK_TTL_MS + 1)).toBe(false);
    expect(existsSync(filePath)).toBe(false);
  });
});

describe('isProFallbackGatewayCode', () => {
  it('matches only the definitive Pro stop codes', () => {
    expect(isProFallbackGatewayCode('allowance_exhausted')).toBe(true);
    expect(isProFallbackGatewayCode('subscription_inactive')).toBe(true);
    expect(isProFallbackGatewayCode('key_invalid')).toBe(false);
    expect(isProFallbackGatewayCode('rate_limited')).toBe(false);
    expect(isProFallbackGatewayCode(undefined)).toBe(false);
    expect(isProFallbackGatewayCode('')).toBe(false);
  });
});

describe('resolveFallbackProvider (provider resolution honors the fallback)', () => {
  it("returns 'claude' for fallback=claude regardless of gemini availability", () => {
    expect(resolveFallbackProvider({ fallbackProvider: 'claude', geminiAvailable: false })).toBe('claude');
    expect(resolveFallbackProvider({ fallbackProvider: 'claude', geminiAvailable: true })).toBe('claude');
  });

  it("returns 'gemini' for fallback=gemini only when a key is available", () => {
    expect(resolveFallbackProvider({ fallbackProvider: 'gemini', geminiAvailable: true })).toBe('gemini');
    expect(resolveFallbackProvider({ fallbackProvider: 'gemini', geminiAvailable: false })).toBeNull();
  });

  it("returns null for fallback=none (caller keeps openrouter and holds dispatch while the marker is fresh)", () => {
    expect(resolveFallbackProvider({ fallbackProvider: 'none', geminiAvailable: true })).toBeNull();
  });

  it('returns null for unknown or empty values', () => {
    expect(resolveFallbackProvider({ fallbackProvider: '', geminiAvailable: true })).toBeNull();
    expect(resolveFallbackProvider({ fallbackProvider: 'openrouter', geminiAvailable: true })).toBeNull();
  });
});

describe('isCmemProBaseUrl', () => {
  const savedOrigin = process.env.CMEM_PRO_ORIGIN;

  afterEach(() => {
    if (savedOrigin === undefined) delete process.env.CMEM_PRO_ORIGIN;
    else process.env.CMEM_PRO_ORIGIN = savedOrigin;
  });

  it('matches the CMEM Pro inference gateway URL', () => {
    delete process.env.CMEM_PRO_ORIGIN;
    expect(isCmemProBaseUrl('https://cmem.ai/api/inference/v1')).toBe(true);
  });

  it('does not match openrouter.ai or other gateways', () => {
    delete process.env.CMEM_PRO_ORIGIN;
    expect(isCmemProBaseUrl('https://openrouter.ai/api/v1')).toBe(false);
    expect(isCmemProBaseUrl('https://api.deepseek.com')).toBe(false);
    expect(isCmemProBaseUrl('http://localhost:1234/v1')).toBe(false);
  });

  it('does not match empty or relative values (default OpenRouter endpoint)', () => {
    delete process.env.CMEM_PRO_ORIGIN;
    expect(isCmemProBaseUrl('')).toBe(false);
    expect(isCmemProBaseUrl('not a url')).toBe(false);
  });

  it('honors the CMEM_PRO_ORIGIN dev override', () => {
    process.env.CMEM_PRO_ORIGIN = 'http://localhost:3005';
    expect(isCmemProBaseUrl('http://localhost:3005/api/inference/v1')).toBe(true);
    expect(isCmemProBaseUrl('https://cmem.ai/api/inference/v1')).toBe(false);
  });
});
