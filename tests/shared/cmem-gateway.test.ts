
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  cmemProOrigin,
  isCmemGatewayUrl,
  writeProFallbackAt,
  clearProFallback,
  clearProFallbackOnGatewaySuccess,
  hasShownProFallbackNotice,
  markProFallbackNoticeShown,
  trialDaysRemaining,
  PRO_FALLBACK_NOTICE_MARKER,
} from '../../src/shared/cmem-gateway.js';

describe('cmem-gateway', () => {
  let tempDir: string;
  let settingsPath: string;
  let prevOrigin: string | undefined;

  beforeEach(() => {
    tempDir = join(tmpdir(), `cmem-gateway-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    settingsPath = join(tempDir, 'settings.json');
    prevOrigin = process.env.CMEM_PRO_ORIGIN;
    delete process.env.CMEM_PRO_ORIGIN;
  });

  afterEach(() => {
    if (prevOrigin === undefined) delete process.env.CMEM_PRO_ORIGIN;
    else process.env.CMEM_PRO_ORIGIN = prevOrigin;
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('cmemProOrigin / isCmemGatewayUrl', () => {
    it('defaults to https://cmem.ai', () => {
      expect(cmemProOrigin()).toBe('https://cmem.ai');
    });

    it('honors the CMEM_PRO_ORIGIN override, trimming trailing slashes', () => {
      process.env.CMEM_PRO_ORIGIN = 'http://localhost:3005/';
      expect(cmemProOrigin()).toBe('http://localhost:3005');
      expect(isCmemGatewayUrl('http://localhost:3005/api/inference/v1')).toBe(true);
      expect(isCmemGatewayUrl('http://localhost:30050/api/inference/v1')).toBe(false);
      expect(isCmemGatewayUrl('http://localhost:3005.evil.example/api/inference/v1')).toBe(false);
    });

    it('recognizes gateway base and request URLs', () => {
      expect(isCmemGatewayUrl('https://cmem.ai/api/inference/v1')).toBe(true);
      expect(isCmemGatewayUrl('https://cmem.ai/api/inference/v1/chat/completions')).toBe(true);
      expect(isCmemGatewayUrl('  https://CMEM.AI:443/api/inference/v1/chat/completions  ')).toBe(true);
    });

    it('rejects blank (default openrouter.ai) and user-owned base URLs', () => {
      expect(isCmemGatewayUrl('')).toBe(false);
      expect(isCmemGatewayUrl('   ')).toBe(false);
      expect(isCmemGatewayUrl(undefined)).toBe(false);
      expect(isCmemGatewayUrl(null)).toBe(false);
      expect(isCmemGatewayUrl('https://openrouter.ai/api/v1')).toBe(false);
      expect(isCmemGatewayUrl('https://api.deepseek.com')).toBe(false);
      expect(isCmemGatewayUrl('https://cmem.ai.evil.example/api/inference/v1')).toBe(false);
      expect(isCmemGatewayUrl('https://cmem.ai-example.com/api/inference/v1')).toBe(false);
      expect(isCmemGatewayUrl('https://cmem.ai@evil.example/api/inference/v1')).toBe(false);
      expect(isCmemGatewayUrl('https://cmem.ai:444/api/inference/v1')).toBe(false);
      expect(isCmemGatewayUrl('http://cmem.ai/api/inference/v1')).toBe(false);
      expect(isCmemGatewayUrl('/api/inference/v1')).toBe(false);
      expect(isCmemGatewayUrl('not a url')).toBe(false);
    });

    it('honors an origin override with a base path on path boundaries', () => {
      process.env.CMEM_PRO_ORIGIN = 'http://localhost:3005/mock/';

      expect(isCmemGatewayUrl('http://localhost:3005/mock')).toBe(true);
      expect(isCmemGatewayUrl('http://localhost:3005/mock/')).toBe(true);
      expect(isCmemGatewayUrl('http://localhost:3005/mock/api/inference/v1')).toBe(true);
      expect(isCmemGatewayUrl('http://localhost:3005/mock/api/inference/v1/chat/completions')).toBe(true);
      expect(isCmemGatewayUrl('http://localhost:3005/mockery/api/inference/v1')).toBe(false);
      expect(isCmemGatewayUrl('http://localhost:3005/api/inference/v1')).toBe(false);
    });
  });

  describe('fallback marker write/clear', () => {
    it('writes CLAUDE_MEM_PRO_FALLBACK_AT into settings.json, preserving unknown keys', () => {
      writeFileSync(settingsPath, JSON.stringify({ SOME_FUTURE_KEY: 'kept', CLAUDE_MEM_PROVIDER: 'openrouter' }));

      writeProFallbackAt('2026-08-26T12:00:00.000Z', settingsPath);

      const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(parsed.CLAUDE_MEM_PRO_FALLBACK_AT).toBe('2026-08-26T12:00:00.000Z');
      expect(parsed.SOME_FUTURE_KEY).toBe('kept');
      expect(parsed.CLAUDE_MEM_PROVIDER).toBe('openrouter');
    });

    it('preserves the legacy env wrapper and peer root settings when writing and clearing', () => {
      writeFileSync(settingsPath, JSON.stringify({
        theme: 'dark',
        permissions: { defaultMode: 'auto' },
        env: {
          CLAUDE_MEM_PROVIDER: 'openrouter',
          CLAUDE_MEM_OPENROUTER_API_KEY: 'cm_pro_test_key',
        },
      }));

      writeProFallbackAt('2026-08-26T12:00:00.000Z', settingsPath);
      let parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(parsed.theme).toBe('dark');
      expect(parsed.permissions).toEqual({ defaultMode: 'auto' });
      expect(parsed.env.CLAUDE_MEM_PROVIDER).toBe('openrouter');
      expect(parsed.env.CLAUDE_MEM_OPENROUTER_API_KEY).toBe('cm_pro_test_key');
      expect(parsed.env.CLAUDE_MEM_PRO_FALLBACK_AT).toBe('2026-08-26T12:00:00.000Z');

      clearProFallback(settingsPath, tempDir);
      parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(parsed.theme).toBe('dark');
      expect(parsed.permissions).toEqual({ defaultMode: 'auto' });
      expect(parsed.env.CLAUDE_MEM_OPENROUTER_API_KEY).toBe('cm_pro_test_key');
      expect(parsed.env.CLAUDE_MEM_PRO_FALLBACK_AT).toBe('');
    });

    it('clearProFallback empties the value and removes the notice marker', () => {
      writeProFallbackAt('2026-08-26T12:00:00.000Z', settingsPath);
      markProFallbackNoticeShown(tempDir);
      expect(hasShownProFallbackNotice(tempDir)).toBe(true);

      clearProFallback(settingsPath, tempDir);

      const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(parsed.CLAUDE_MEM_PRO_FALLBACK_AT).toBe('');
      expect(hasShownProFallbackNotice(tempDir)).toBe(false);
      expect(existsSync(join(tempDir, PRO_FALLBACK_NOTICE_MARKER))).toBe(false);
    });

    it('keeps successful callers fail-soft when settings cleanup cannot be parsed', () => {
      writeFileSync(settingsPath, '{ invalid json');
      markProFallbackNoticeShown(tempDir);

      expect(() => clearProFallback(settingsPath, tempDir)).not.toThrow();

      expect(readFileSync(settingsPath, 'utf-8')).toBe('{ invalid json');
      expect(existsSync(join(tempDir, PRO_FALLBACK_NOTICE_MARKER))).toBe(false);
    });

    it('clearProFallbackOnGatewaySuccess clears only for cmem-gateway request URLs', () => {
      writeProFallbackAt('2026-08-26T12:00:00.000Z', settingsPath);

      clearProFallbackOnGatewaySuccess('https://openrouter.ai/api/v1/chat/completions', settingsPath, tempDir);
      expect(JSON.parse(readFileSync(settingsPath, 'utf-8')).CLAUDE_MEM_PRO_FALLBACK_AT)
        .toBe('2026-08-26T12:00:00.000Z');

      clearProFallbackOnGatewaySuccess('https://cmem.ai.evil.example/api/inference/v1/chat/completions', settingsPath, tempDir);
      expect(JSON.parse(readFileSync(settingsPath, 'utf-8')).CLAUDE_MEM_PRO_FALLBACK_AT)
        .toBe('2026-08-26T12:00:00.000Z');

      clearProFallbackOnGatewaySuccess('https://cmem.ai/api/inference/v1/chat/completions', settingsPath, tempDir);
      expect(JSON.parse(readFileSync(settingsPath, 'utf-8')).CLAUDE_MEM_PRO_FALLBACK_AT).toBe('');
    });
  });

  describe('one-time notice marker', () => {
    it('starts unshown, becomes shown after marking', () => {
      expect(hasShownProFallbackNotice(tempDir)).toBe(false);
      markProFallbackNoticeShown(tempDir);
      expect(hasShownProFallbackNotice(tempDir)).toBe(true);
    });
  });

  describe('trialDaysRemaining', () => {
    const now = Date.parse('2026-08-26T12:00:00.000Z');

    it('returns null when the end date is absent or unparseable', () => {
      expect(trialDaysRemaining('', now)).toBeNull();
      expect(trialDaysRemaining('   ', now)).toBeNull();
      expect(trialDaysRemaining(undefined, now)).toBeNull();
      expect(trialDaysRemaining(null, now)).toBeNull();
      expect(trialDaysRemaining('not-a-date', now)).toBeNull();
    });

    it('returns 0 when the trial ends later today', () => {
      expect(trialDaysRemaining('2026-08-26T18:00:00.000Z', now)).toBe(0);
      expect(trialDaysRemaining('2026-08-26T12:00:00.000Z', now)).toBe(0);
    });

    it('returns whole days for a future end date', () => {
      expect(trialDaysRemaining('2026-08-29T18:00:00.000Z', now)).toBe(3);
      expect(trialDaysRemaining('2026-09-02T12:00:00.000Z', now)).toBe(7);
    });

    it('goes negative once the end date is past (caller hides N < 0)', () => {
      expect(trialDaysRemaining('2026-08-26T11:00:00.000Z', now)).toBeLessThan(0);
      expect(trialDaysRemaining('2026-08-19T12:00:00.000Z', now)).toBe(-7);
    });
  });
});
