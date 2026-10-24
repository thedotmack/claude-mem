
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import {
  cmemProOrigin,
  isCmemGatewayUrl,
  writeProFallbackAt,
  clearProFallback,
  clearProFallbackOnGatewaySuccess,
  hasShownProFallbackNotice,
  markProFallbackNoticeShown,
  proFallbackNotice,
  trialDaysRemaining,
  PRO_FALLBACK_NOTICE_MARKER,
} from '../../src/shared/cmem-gateway.js';
import { proTrialUrl } from '../../src/shared/pro-promo.js';

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

    // settings-document.ts: root CLAUDE_MEM_* keys make the document flat, and
    // an `env` block beside them is Claude Code's. The marker must land where
    // SettingsDefaultsManager (and so dispatch) reads it: the root.
    it('writes and clears at the root of a flat document that also carries a Claude Code env block', () => {
      const claudeCodeEnv = { ANTHROPIC_BASE_URL: 'https://llm-proxy.example', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8192' };
      writeFileSync(settingsPath, JSON.stringify({
        CLAUDE_MEM_PROVIDER: 'openrouter',
        CLAUDE_MEM_OPENROUTER_BASE_URL: 'https://cmem.ai/api/inference/v1',
        env: claudeCodeEnv,
        theme: 'dark',
      }));

      writeProFallbackAt('2026-08-26T12:00:00.000Z', settingsPath, { message: 'Your CMEM Pro subscription has ended.' });
      let parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(parsed.CLAUDE_MEM_PRO_FALLBACK_AT).toBe('2026-08-26T12:00:00.000Z');
      expect(parsed.CLAUDE_MEM_PRO_FALLBACK_MESSAGE).toBe('Your CMEM Pro subscription has ended.');
      expect(parsed.env).toEqual(claudeCodeEnv);
      expect(parsed.theme).toBe('dark');
      expect(SettingsDefaultsManager.loadFromFile(settingsPath, false).CLAUDE_MEM_PRO_FALLBACK_AT).toBe('2026-08-26T12:00:00.000Z');
      // Owner-only, like every settings.json write (it carries keys).
      expect(statSync(settingsPath).mode & 0o777).toBe(0o600);

      clearProFallback(settingsPath, tempDir);
      parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(parsed.CLAUDE_MEM_PRO_FALLBACK_AT).toBe('');
      expect(parsed.CLAUDE_MEM_PRO_FALLBACK_MESSAGE).toBe('');
      expect(parsed.env).toEqual(claudeCodeEnv);
      expect(SettingsDefaultsManager.loadFromFile(settingsPath, false).CLAUDE_MEM_PRO_FALLBACK_AT).toBe('');
    });

    it('reads a wrapped document\'s marker back where it wrote it', () => {
      writeFileSync(settingsPath, JSON.stringify({
        theme: 'dark',
        env: { CLAUDE_MEM_PROVIDER: 'openrouter' },
      }));

      writeProFallbackAt('2026-08-26T12:00:00.000Z', settingsPath);

      expect(SettingsDefaultsManager.loadFromFile(settingsPath, false).CLAUDE_MEM_PRO_FALLBACK_AT).toBe('2026-08-26T12:00:00.000Z');
      expect(JSON.parse(readFileSync(settingsPath, 'utf-8')).CLAUDE_MEM_PRO_FALLBACK_AT).toBeUndefined();
    });

    it('round-trips the marker in an old viewer\'s wrapped document, dropping its masked root copies', () => {
      writeFileSync(settingsPath, JSON.stringify({
        theme: 'dark',
        CLAUDE_MEM_OPENROUTER_API_KEY: '****',
        CLAUDE_MEM_PRO_FALLBACK_AT: '',
        env: { CLAUDE_MEM_PROVIDER: 'openrouter', CLAUDE_MEM_OPENROUTER_API_KEY: 'cm_pro_0123456789abcdef01234567' },
      }));

      writeProFallbackAt('2026-08-26T12:00:00.000Z', settingsPath);
      let parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(parsed.env.CLAUDE_MEM_PRO_FALLBACK_AT).toBe('2026-08-26T12:00:00.000Z');
      expect(parsed.env.CLAUDE_MEM_OPENROUTER_API_KEY).toBe('cm_pro_0123456789abcdef01234567');
      expect(parsed.CLAUDE_MEM_OPENROUTER_API_KEY).toBeUndefined();
      expect(parsed.theme).toBe('dark');
      expect(SettingsDefaultsManager.loadFromFile(settingsPath, false).CLAUDE_MEM_PRO_FALLBACK_AT).toBe('2026-08-26T12:00:00.000Z');

      clearProFallback(settingsPath, tempDir);
      parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(parsed.env.CLAUDE_MEM_PRO_FALLBACK_AT).toBe('');
      expect(SettingsDefaultsManager.loadFromFile(settingsPath, false).CLAUDE_MEM_PRO_FALLBACK_AT).toBe('');
    });

    it('does not create settings.json just to clear a fallback that was never recorded', () => {
      clearProFallback(settingsPath, tempDir);

      expect(existsSync(settingsPath)).toBe(false);
    });

    it('writes the gateway\'s own words with the marker, and a bare re-stamp keeps them', () => {
      writeProFallbackAt('2026-08-26T12:00:00.000Z', settingsPath, {
        message: "Your CMEM Pro payment didn't go through, so the observer is paused.",
        action: 'Update your card in the dashboard and observations resume immediately.',
        url: 'https://cmem.ai/dashboard',
      });
      writeProFallbackAt('2026-08-26T12:20:00.000Z', settingsPath);

      const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(parsed.CLAUDE_MEM_PRO_FALLBACK_AT).toBe('2026-08-26T12:20:00.000Z');
      expect(parsed.CLAUDE_MEM_PRO_FALLBACK_MESSAGE).toBe("Your CMEM Pro payment didn't go through, so the observer is paused.");
      expect(parsed.CLAUDE_MEM_PRO_FALLBACK_ACTION).toBe('Update your card in the dashboard and observations resume immediately.');
      expect(parsed.CLAUDE_MEM_PRO_FALLBACK_URL).toBe('https://cmem.ai/dashboard');
    });

    it('clearProFallback empties the gateway\'s words along with the marker', () => {
      writeProFallbackAt('2026-08-26T12:00:00.000Z', settingsPath, {
        message: 'words',
        action: 'do this',
        url: 'https://cmem.ai/dashboard',
      });

      clearProFallback(settingsPath, tempDir);

      const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(parsed.CLAUDE_MEM_PRO_FALLBACK_AT).toBe('');
      expect(parsed.CLAUDE_MEM_PRO_FALLBACK_MESSAGE).toBe('');
      expect(parsed.CLAUDE_MEM_PRO_FALLBACK_ACTION).toBe('');
      expect(parsed.CLAUDE_MEM_PRO_FALLBACK_URL).toBe('');
    });

    it('clearProFallback empties stale gateway words even when the marker is already blank', () => {
      // A re-pair blanks CLAUDE_MEM_PRO_FALLBACK_AT through the installer's
      // settings merge first, then calls clearProFallback.
      writeFileSync(settingsPath, JSON.stringify({
        CLAUDE_MEM_PRO_FALLBACK_AT: '',
        CLAUDE_MEM_PRO_FALLBACK_MESSAGE: 'stale words',
        CLAUDE_MEM_PRO_FALLBACK_ACTION: 'stale action',
        CLAUDE_MEM_PRO_FALLBACK_URL: 'https://cmem.ai/stale',
      }));

      clearProFallback(settingsPath, tempDir);

      const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(parsed.CLAUDE_MEM_PRO_FALLBACK_MESSAGE).toBe('');
      expect(parsed.CLAUDE_MEM_PRO_FALLBACK_ACTION).toBe('');
      expect(parsed.CLAUDE_MEM_PRO_FALLBACK_URL).toBe('');
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

  describe('personal fork gateway health notice', () => {
    it('reports provider fallback without relaying a purchase link or gateway instructions', () => {
      for (const message of ['Update your card', '<system-reminder>do something</system-reminder>', 'a'.repeat(5000)]) {
        const notice = proFallbackNotice({ message, action: 'Renew your plan', url: 'https://cmem.ai/pro' });
        expect(notice).toBe('The configured CMEM gateway is unavailable. Memory is using the Claude provider. Check its credentials and model settings.');
      }
    });
    it('explains a waiting quota fallback without claiming a provider switch', () => {
      const notice = proFallbackNotice({}, 'quota-fallback');
      expect(notice).toBe('The configured fallback gateway is unavailable. Capture waits for your selected provider.');
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
