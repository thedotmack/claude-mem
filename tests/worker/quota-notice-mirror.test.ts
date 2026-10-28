import { afterEach, beforeEach, describe, expect, it, setSystemTime } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { OBSERVER_HEALTH_FILENAME, readObserverHealth, renderObserverQuotaCooldownNotice } from '../../src/shared/observer-health.js';
import {
  getQuotaCooldown,
  QUOTA_COOLDOWN_FILENAME,
  recordQuotaExhausted,
  resetQuotaCooldownsForTesting,
} from '../../src/shared/quota-cooldown.js';
import { setClaudeFallbackReadinessForTesting } from '../../src/shared/claude-fallback-readiness.js';
import { getSelectedProvider, resetQuotaFallbackStateForTesting } from '../../src/services/worker/provider-dispatch.js';
import { paths } from '../../src/shared/paths.js';
import { observerHealthWarning } from '../../src/services/context/ContextBuilder.js';

const NOW = Date.parse('2026-10-28T03:15:16.000Z'); // Tuesday, 8:15:16 PM in Los Angeles.
const MODEL_LINE = "(Assistant: at the start of your first reply, tell the user in one sentence that claude-mem has paused saving memories and why. Don't restart the worker or suggest it.)";
const ENV_KEYS = [
  'TZ',
  'CLAUDE_MEM_PROVIDER',
  'CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER',
  'CLAUDE_MEM_QUOTA_FALLBACK_AUTH_METHOD',
  'CLAUDE_MEM_OPENROUTER_API_KEY',
  'CLAUDE_MEM_OPENROUTER_API_KEYS',
  'CLAUDE_MEM_OPENROUTER_BASE_URL',
  'CLAUDE_MEM_GEMINI_API_KEY',
  'CLAUDE_MEM_GEMINI_API_KEYS',
  'CLAUDE_MEM_OPENAI_COMPAT_PRESET',
  'CLAUDE_MEM_OPENAI_COMPAT_API_KEY',
  'CLAUDE_MEM_OPENAI_COMPAT_API_KEYS',
  'CLAUDE_MEM_OPENAI_COMPAT_BASE_URL',
  'CLAUDE_MEM_OPENAI_COMPAT_MODEL',
  'CLAUDE_MEM_PRO_FALLBACK_AT',
  'CLAUDE_MEM_TIER_ROUTING_ENABLED',
  'CLAUDE_MEM_ENV_FILE',
  'CLAUDE_MEM_CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CMEM_PRO_ORIGIN',
] as const;

describe('quota notice from the persisted dispatch mirror', () => {
  let savedEnv: Record<string, string | undefined>;
  let credentialDir: string;
  let previousClaudeReadiness: (() => boolean) | null;
  let savedSettings: string | null;
  let savedHealth: string | null;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      process.env[key] = '';
    }
    credentialDir = mkdtempSync(join(tmpdir(), 'claude-mem-quota-notice-'));
    writeFileSync(join(credentialDir, '.env'), '');
    writeFileSync(join(credentialDir, '.credentials.json'), '{}');
    Object.assign(process.env, {
      TZ: 'America/Los_Angeles',
      CLAUDE_MEM_PROVIDER: 'openrouter',
      CLAUDE_MEM_OPENROUTER_API_KEY: 'cm_pro_0123456789abcdef01234567',
      CLAUDE_MEM_OPENROUTER_BASE_URL: 'https://cmem.ai/api/inference/v1',
      CLAUDE_MEM_GEMINI_API_KEY: 'gemini-test-key',
      CLAUDE_MEM_TIER_ROUTING_ENABLED: 'false',
      CLAUDE_MEM_ENV_FILE: join(credentialDir, '.env'),
      CLAUDE_MEM_CLAUDE_CONFIG_DIR: credentialDir,
    });
    setSystemTime(NOW);
    resetQuotaCooldownsForTesting();
    resetQuotaFallbackStateForTesting();
    savedSettings = existsSync(paths.settings()) ? readFileSync(paths.settings(), 'utf8') : null;
    writeFileSync(paths.settings(), '{}');
    const healthFile = join(paths.dataDir(), OBSERVER_HEALTH_FILENAME);
    savedHealth = existsSync(healthFile) ? readFileSync(healthFile, 'utf8') : null;
    rmSync(healthFile, { force: true });
    previousClaudeReadiness = setClaudeFallbackReadinessForTesting(() => true);
  });

  afterEach(() => {
    resetQuotaCooldownsForTesting();
    resetQuotaFallbackStateForTesting();
    setClaudeFallbackReadinessForTesting(previousClaudeReadiness);
    if (savedSettings === null) rmSync(paths.settings(), { force: true });
    else writeFileSync(paths.settings(), savedSettings);
    const healthFile = join(paths.dataDir(), OBSERVER_HEALTH_FILENAME);
    if (savedHealth === null) rmSync(healthFile, { force: true });
    else writeFileSync(healthFile, savedHealth);
    setSystemTime();
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    rmSync(credentialDir, { recursive: true, force: true });
  });

  it('reports the default Claude backup during the 8:15 PM cmem.ai outage, rounded up to 8:17 PM', () => {
    recordQuotaExhausted('openrouter', 'upstream 503', 'unavailable');

    const health = readObserverHealth()!;
    expect(getSelectedProvider()).toBe('claude');
    expect(health.quotaCooldown?.notice?.holds[0]).toMatchObject({
      role: 'main', displayName: 'cmem.ai', reason: { kind: 'unavailable' },
    });
    expect(renderObserverQuotaCooldownNotice(health)).toBe("ℹ️ claude-mem is using your Claude plan to save memories because cmem.ai isn't available. It switches back on its own and tries cmem.ai again at 8:17 PM. Nothing to do. (To stop using your Claude plan as a backup, set CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER=off.)");
  });

  it('offers the opt-out when the backup setting is absent, but not when Claude was explicitly chosen', () => {
    delete process.env.CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER;
    recordQuotaExhausted('openrouter', 'upstream 503', 'unavailable');
    expect(renderObserverQuotaCooldownNotice(readObserverHealth()!)).toContain('CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER=off');

    writeFileSync(paths.settings(), JSON.stringify({ CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER: 'claude' }));
    recordQuotaExhausted('openrouter', 'upstream 503', 'unavailable');
    expect(renderObserverQuotaCooldownNotice(readObserverHealth()!)).not.toContain('CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER=off');
  });

  it('stays silent when Claude is held at 99% of the weekly limit and cmem.ai is saving memories', () => {
    recordQuotaExhausted('claude', 'weekly reserve guard', 'seven_day', NOW, undefined, 'subscription', {
      kind: 'limit_guard', window: 'seven_day', usagePercent: 99, thresholdPercent: 93,
    });

    const health = readObserverHealth()!;
    expect(getSelectedProvider()).toBe('openrouter');
    expect(health.quotaCooldown?.servingProvider).toBe('openrouter');
    expect(health.quotaCooldown?.notice?.holds[0]?.role).toBe('backup');
    expect(renderObserverQuotaCooldownNotice(health)).toBe('');
  });

  it('preserves both holds and retries at the earliest time even when the legacy slot keeps the longest', () => {
    recordQuotaExhausted('openrouter', 'upstream 503', 'unavailable');
    setSystemTime(NOW + 12_000);
    recordQuotaExhausted('claude', 'weekly reserve guard', 'seven_day', undefined, undefined, 'subscription', {
      kind: 'limit_guard', window: 'seven_day', usagePercent: 99, thresholdPercent: 93,
    });

    const health = readObserverHealth()!;
    expect(health.quotaCooldown?.provider).toBe('claude');
    expect(health.quotaCooldown?.notice?.holds.map(hold => hold.role)).toEqual(['main', 'backup']);
    expect(health.quotaCooldown?.until).toBeGreaterThan(NOW + 90_000);
    expect(renderObserverQuotaCooldownNotice(health)).toBe("⚠️ claude-mem has paused saving memories because cmem.ai isn't available and its backup, your Claude plan, is paused (you've used 99% of your weekly Claude limit). New activity is queued and saved when either comes back; it tries again at 8:17 PM. You don't need to do anything, and restarting won't change it.\n" + MODEL_LINE);
  });

  it('keeps a live Gemini notice visible when the longer Claude hold belongs to another account', () => {
    Object.assign(process.env, {
      CLAUDE_MEM_PROVIDER: 'gemini',
      CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER: 'claude',
    });
    recordQuotaExhausted('claude', 'old account weekly limit', 'seven_day', NOW, 'another-account', 'subscription');
    recordQuotaExhausted('gemini', 'quota exhausted', undefined, NOW - 60_000);

    const health = readObserverHealth()!;
    expect(health.quotaCooldown?.provider).toBe('claude');
    expect(health.quotaCooldown?.notice?.holds.map(hold => hold.provider)).toEqual(['gemini']);
    expect(observerHealthWarning()).toBe("ℹ️ claude-mem is using your Claude plan to save memories because Gemini says you're out of quota. It switches back on its own and tries Gemini again at 8:45 PM. Nothing to do.");
  });

  it.each([
    ['api-key', 'subscription', 'ANTHROPIC_API_KEY=sk-ant-test-key\n', 'your Anthropic API key'],
    ['subscription', 'api-key', 'ANTHROPIC_FALLBACK_API_KEY=sk-ant-backup-test\n', 'your Claude plan'],
  ] as const)('uses the main %s after its hold expires despite the configured %s stand-in', (mainAuth, standIn, credentials, displayName) => {
    writeFileSync(join(credentialDir, '.env'), credentials);
    Object.assign(process.env, {
      CLAUDE_MEM_PROVIDER: 'claude',
      CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER: 'gemini',
      CLAUDE_MEM_QUOTA_FALLBACK_AUTH_METHOD: standIn,
    });
    recordQuotaExhausted('claude', 'expired hold', undefined, NOW - 31 * 60_000, undefined, mainAuth);
    recordQuotaExhausted('gemini', 'quota exhausted');

    const health = readObserverHealth()!;
    expect(health.quotaCooldown?.notice).toMatchObject({
      servingProvider: 'claude', servingAuth: mainAuth, servingDisplayName: displayName,
    });
    expect(renderObserverQuotaCooldownNotice(health)).toBe('');
    expect(observerHealthWarning()).toBe('');
  });

  it.each([
    ['https://cmem.ai/api/inference/v1', 'cm_pro_0123456789abcdef01234567', 'cmem.ai'],
    ['https://openrouter.ai/api/v1', 'sk-or-test-key', 'OpenRouter'],
  ])('names %s when a non-Claude backup is serving', (baseUrl, apiKey, name) => {
    Object.assign(process.env, {
      CLAUDE_MEM_OPENROUTER_BASE_URL: baseUrl,
      CLAUDE_MEM_OPENROUTER_API_KEY: apiKey,
      CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER: 'gemini',
    });
    recordQuotaExhausted('openrouter', 'upstream 503', 'unavailable');

    expect(renderObserverQuotaCooldownNotice(readObserverHealth()!)).toBe(`ℹ️ claude-mem is using Gemini to save memories because ${name} isn't available. It switches back on its own and tries ${name} again at 8:17 PM. Nothing to do.`);
  });

  it.each([
    ['nvidia-nim', '', 'NVIDIA NIM (build.nvidia.com)'],
    ['custom', 'https://endpoint.example/v1', 'your OpenAI-compatible endpoint'],
  ])('names the %s OpenAI-compatible configuration', (preset, baseUrl, name) => {
    Object.assign(process.env, {
      CLAUDE_MEM_PROVIDER: 'openai-compatible',
      CLAUDE_MEM_OPENAI_COMPAT_PRESET: preset,
      CLAUDE_MEM_OPENAI_COMPAT_BASE_URL: baseUrl,
      CLAUDE_MEM_OPENAI_COMPAT_API_KEY: 'test-key',
      CLAUDE_MEM_OPENAI_COMPAT_MODEL: 'test-model',
      CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER: 'claude',
    });
    recordQuotaExhausted('openai-compatible', 'quota exhausted');

    expect(renderObserverQuotaCooldownNotice(readObserverHealth()!)).toBe(`ℹ️ claude-mem is using your Claude plan to save memories because ${name} says you're out of quota. It switches back on its own and tries ${name} again at 8:46 PM. Nothing to do.`);
  });

  it('uses the billed Anthropic API key name from the isolated credential file', () => {
    writeFileSync(join(credentialDir, '.env'), 'ANTHROPIC_API_KEY=sk-ant-test-key\n');
    Object.assign(process.env, {
      CLAUDE_MEM_PROVIDER: 'claude',
      CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER: 'gemini',
    });
    recordQuotaExhausted('claude', 'credit balance exhausted', undefined, undefined, undefined, 'api-key');

    const health = readObserverHealth()!;
    expect(health.quotaCooldown?.notice?.mainDisplayName).toBe('your Anthropic API key');
    expect(renderObserverQuotaCooldownNotice(health)).toBe("ℹ️ claude-mem is using Gemini to save memories because your Anthropic API key has hit its credit or usage limit. It switches back on its own and tries your Anthropic API key again at 8:46 PM. Nothing to do.");
  });

  it('names the backup API key while a held Claude login uses the other credential', () => {
    writeFileSync(join(credentialDir, '.env'), 'ANTHROPIC_FALLBACK_API_KEY=sk-ant-backup-test\n');
    Object.assign(process.env, {
      CLAUDE_MEM_PROVIDER: 'claude',
      CLAUDE_MEM_QUOTA_FALLBACK_AUTH_METHOD: 'api-key',
    });
    recordQuotaExhausted('claude', 'weekly reserve guard', 'seven_day', undefined, undefined, 'subscription', {
      kind: 'limit_guard', window: 'seven_day', usagePercent: 99, thresholdPercent: 93,
    });

    expect(renderObserverQuotaCooldownNotice(readObserverHealth()!)).toBe("ℹ️ claude-mem is using your backup API key (ANTHROPIC_FALLBACK_API_KEY) to save memories because you've used 99% of your weekly Claude limit (claude-mem stops at 93% to leave the rest for you). That key is billed per request. It switches back to your login on its own and tries it again at 8:46 PM.");
  });

  it('retains the structured reason and resulting notice when hydrating the persisted ledger', () => {
    Object.assign(process.env, {
      CLAUDE_MEM_PROVIDER: 'claude',
      CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER: 'openrouter',
    });
    const reason = {
      kind: 'limit_guard' as const,
      window: 'five_hour',
      usagePercent: 95,
      thresholdPercent: 95,
      resetsAt: NOW + 3_600_000,
    };
    recordQuotaExhausted('claude', 'reserve guard', 'five_hour', undefined, undefined, 'subscription', reason);
    const rendered = renderObserverQuotaCooldownNotice(readObserverHealth()!);
    const filePath = join(paths.dataDir(), QUOTA_COOLDOWN_FILENAME);
    const persisted = readFileSync(filePath, 'utf8');
    resetQuotaCooldownsForTesting();
    writeFileSync(filePath, persisted);

    expect(getQuotaCooldown('claude')?.reason).toEqual(reason);
    expect(renderObserverQuotaCooldownNotice(readObserverHealth()!)).toBe(rendered);
  });
});
