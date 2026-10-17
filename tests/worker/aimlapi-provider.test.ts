import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  AimlapiProvider,
  isAimlapiAvailable,
  isAimlapiSelected,
  resolveAimlapiConfig,
} from '../../src/services/worker/AimlapiProvider.js';
import {
  QUOTA_FALLBACK_PROVIDERS,
  getSelectedProvider,
  resetQuotaFallbackStateForTesting,
  selectProviderForGenerator,
} from '../../src/services/worker/provider-dispatch.js';
import { recordQuotaExhausted, resetQuotaCooldownsForTesting } from '../../src/shared/quota-cooldown.js';
import { setClaudeFallbackReadinessForTesting } from '../../src/shared/claude-fallback-readiness.js';
import { AIMLAPI_PARTNER_ID, AIMLAPI_SOURCE } from '../../src/shared/aimlapi-attribution.js';
import { AIMLAPI_DEFAULT_MODEL } from '../../src/shared/aimlapi-base-url.js';
import { SettingsRoutes } from '../../src/services/worker/http/routes/SettingsRoutes.js';
import type { ConversationMessage } from '../../src/services/worker-types.js';

/**
 * SettingsDefaultsManager applies process.env LAST, so pinning these (empty
 * string included) fully determines what the resolvers read, whatever the
 * preload's temp settings file holds.
 */
const ENV_KEYS = [
  'CLAUDE_MEM_PROVIDER',
  'CLAUDE_MEM_AIMLAPI_API_KEY',
  'CLAUDE_MEM_AIMLAPI_BASE_URL',
  'CLAUDE_MEM_AIMLAPI_MODEL',
  'CLAUDE_MEM_AIMLAPI_SITE_URL',
  'CLAUDE_MEM_AIMLAPI_APP_NAME',
  'AIMLAPI_API_KEY',
  'CLAUDE_MEM_ENV_FILE',
  'CLAUDE_MEM_OPENROUTER_API_KEY',
  'CLAUDE_MEM_GEMINI_API_KEY',
  'CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER',
] as const;

let savedEnv: Record<string, string | undefined>;
let envDir: string;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  // An empty ~/.claude-mem/.env stand-in, so a developer's real one never leaks in.
  envDir = mkdtempSync(join(tmpdir(), 'aimlapi-env-'));
  process.env.CLAUDE_MEM_ENV_FILE = join(envDir, '.env');
  process.env.CLAUDE_MEM_AIMLAPI_API_KEY = '';
  process.env.CLAUDE_MEM_AIMLAPI_BASE_URL = '';
  process.env.CLAUDE_MEM_AIMLAPI_MODEL = '';
  process.env.CLAUDE_MEM_AIMLAPI_SITE_URL = '';
  process.env.CLAUDE_MEM_AIMLAPI_APP_NAME = '';
  process.env.CLAUDE_MEM_OPENROUTER_API_KEY = '';
  process.env.CLAUDE_MEM_GEMINI_API_KEY = '';
  // 'off' so a test only routes around a provider when it names a fallback.
  process.env.CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER = 'off';
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(envDir, { recursive: true, force: true });
});

describe('aimlapi credential resolution', () => {
  // Greptile on #3745: with only the documented process-level AIMLAPI_API_KEY,
  // the provider reported itself unavailable and dispatch fell back to Claude.
  it('honors a process-level AIMLAPI_API_KEY for both availability and the key', () => {
    process.env.AIMLAPI_API_KEY = 'aiml-env-key';
    expect(isAimlapiAvailable()).toBe(true);
    expect(resolveAimlapiConfig().apiKey).toBe('aiml-env-key');
  });

  it('reads AIMLAPI_API_KEY from ~/.claude-mem/.env', () => {
    writeFileSync(process.env.CLAUDE_MEM_ENV_FILE!, 'AIMLAPI_API_KEY=aiml-file-key\n');
    expect(resolveAimlapiConfig().apiKey).toBe('aiml-file-key');
  });

  it('prefers CLAUDE_MEM_AIMLAPI_API_KEY over the environment fallback', () => {
    process.env.AIMLAPI_API_KEY = 'aiml-env-key';
    process.env.CLAUDE_MEM_AIMLAPI_API_KEY = 'aiml-settings-key';
    expect(resolveAimlapiConfig().apiKey).toBe('aiml-settings-key');
  });

  it('is unavailable with no key anywhere', () => {
    expect(isAimlapiAvailable()).toBe(false);
  });

  it('never sends a cmem.ai memory key to aimlapi.com', () => {
    process.env.AIMLAPI_API_KEY = 'cm_pro_0123456789abcdef01234567';
    expect(resolveAimlapiConfig().apiKeys).toEqual([]);
    expect(isAimlapiAvailable()).toBe(false);
  });

  it('defaults the endpoint and model', () => {
    const config = resolveAimlapiConfig();
    expect(config.apiUrl).toBe('https://api.aimlapi.com/v1/chat/completions');
    expect(config.model).toBe(AIMLAPI_DEFAULT_MODEL);
  });
});

describe('aimlapi provider dispatch', () => {
  let previousClaudeReadiness: ReturnType<typeof setClaudeFallbackReadinessForTesting>;
  beforeEach(() => {
    resetQuotaCooldownsForTesting();
    resetQuotaFallbackStateForTesting();
    // The preload pins Claude to "not signed in"; these runs have a Claude login.
    previousClaudeReadiness = setClaudeFallbackReadinessForTesting(() => true);
  });
  afterEach(() => {
    setClaudeFallbackReadinessForTesting(previousClaudeReadiness);
    resetQuotaCooldownsForTesting();
    resetQuotaFallbackStateForTesting();
  });

  it('selects aimlapi only when settings name it', () => {
    process.env.CLAUDE_MEM_PROVIDER = 'aimlapi';
    expect(isAimlapiSelected()).toBe(true);
    process.env.CLAUDE_MEM_PROVIDER = 'openrouter';
    expect(isAimlapiSelected()).toBe(false);
  });

  it('dispatches to aimlapi when selected and keyed from the environment', () => {
    process.env.CLAUDE_MEM_PROVIDER = 'aimlapi';
    process.env.AIMLAPI_API_KEY = 'aiml-env-key';
    expect(getSelectedProvider()).toBe('aimlapi');
    expect(selectProviderForGenerator()).toEqual({ provider: 'aimlapi', gatewayProbeClaimId: null });
  });

  it('falls through to claude when selected without a key', () => {
    process.env.CLAUDE_MEM_PROVIDER = 'aimlapi';
    expect(getSelectedProvider()).toBe('claude');
  });

  it('routes a spent aimlapi allowance to the configured quota fallback', () => {
    process.env.CLAUDE_MEM_PROVIDER = 'aimlapi';
    process.env.AIMLAPI_API_KEY = 'aiml-env-key';
    process.env.CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER = 'claude';
    recordQuotaExhausted('aimlapi', 'Insufficient credits');
    expect(selectProviderForGenerator()).toEqual({ provider: 'claude', gatewayProbeClaimId: null, fallbackFrom: 'aimlapi' });
  });

  it('falls back to Claude by default while a rate-limit hold keeps aimlapi out', () => {
    process.env.CLAUDE_MEM_PROVIDER = 'aimlapi';
    process.env.AIMLAPI_API_KEY = 'aiml-env-key';
    // Empty is the default: the Anthropic plan.
    process.env.CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER = '';
    recordQuotaExhausted('aimlapi', 'Provider rate limited the request', 'rate_limit');
    expect(selectProviderForGenerator()).toEqual({ provider: 'claude', gatewayProbeClaimId: null, fallbackFrom: 'aimlapi' });
    expect(getSelectedProvider()).toBe('claude');
  });

  it('stays on aimlapi under a hold when the fallback is turned off', () => {
    process.env.CLAUDE_MEM_PROVIDER = 'aimlapi';
    process.env.AIMLAPI_API_KEY = 'aiml-env-key';
    recordQuotaExhausted('aimlapi', 'Provider rate limited the request', 'rate_limit');
    expect(selectProviderForGenerator()).toEqual({ provider: 'aimlapi', gatewayProbeClaimId: null });
  });

  it('can itself be the quota fallback', () => {
    expect(QUOTA_FALLBACK_PROVIDERS).toContain('aimlapi');
    process.env.CLAUDE_MEM_PROVIDER = 'gemini';
    process.env.CLAUDE_MEM_GEMINI_API_KEY = 'gemini-test-key';
    process.env.AIMLAPI_API_KEY = 'aiml-env-key';
    process.env.CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER = 'aimlapi';
    recordQuotaExhausted('gemini', 'Daily limit reached');
    expect(selectProviderForGenerator()).toEqual({ provider: 'aimlapi', gatewayProbeClaimId: null, fallbackFrom: 'gemini' });
  });
});

describe('aimlapi attribution headers reach aimlapi.com only', () => {
  const reply = () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
  const history: ConversationMessage[] = [{ role: 'user', content: 'observation' }];

  async function sentRequest(): Promise<{ url: string; headers: Record<string, string> }> {
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(reply());
    try {
      const provider = new AimlapiProvider({} as never, {} as never) as unknown as {
        query(h: ConversationMessage[], c: unknown): Promise<unknown>;
      };
      await provider.query(history, resolveAimlapiConfig());
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      return { url: String(url), headers: init.headers as Record<string, string> };
    } finally {
      fetchSpy.mockRestore();
    }
  }

  it('sends the attribution pair and the key to api.aimlapi.com', async () => {
    process.env.AIMLAPI_API_KEY = 'aiml-env-key';
    const { url, headers } = await sentRequest();
    expect(url).toBe('https://api.aimlapi.com/v1/chat/completions');
    expect(headers['X-AIMLAPI-Source']).toBe(AIMLAPI_SOURCE);
    expect(headers['X-AIMLAPI-Partner-ID']).toBe(AIMLAPI_PARTNER_ID);
    expect(headers['HTTP-Referer']).toBe('https://github.com/thedotmack/claude-mem');
    expect(headers['X-Title']).toBe('Claude-Mem');
    expect(headers['Authorization']).toBe('Bearer aiml-env-key');
  });

  it('sends none of them when the base URL points at another host', async () => {
    process.env.AIMLAPI_API_KEY = 'aiml-env-key';
    process.env.CLAUDE_MEM_AIMLAPI_BASE_URL = 'https://proxy.example.test/v1';
    const { url, headers } = await sentRequest();
    expect(url).toBe('https://proxy.example.test/v1/chat/completions');
    for (const name of ['X-AIMLAPI-Source', 'X-AIMLAPI-Partner-ID', 'HTTP-Referer', 'X-Title']) {
      expect(headers[name]).toBeUndefined();
    }
  });
});

describe('aimlapi in the settings API', () => {
  const validate = (settings: Record<string, string>): { valid: boolean; error?: string } =>
    (new SettingsRoutes({} as never) as unknown as {
      validateSettings(s: unknown): { valid: boolean; error?: string };
    }).validateSettings(settings);

  it('accepts aimlapi as a provider and as a quota fallback', () => {
    expect(validate({ CLAUDE_MEM_PROVIDER: 'aimlapi' }).valid).toBe(true);
    expect(validate({ CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER: 'aimlapi' }).valid).toBe(true);
  });

  it('masks the aimlapi key on GET /api/settings', () => {
    const source = readFileSync(
      new URL('../../src/services/worker/http/routes/SettingsRoutes.ts', import.meta.url),
      'utf-8',
    );
    const secretBlock = source.slice(
      source.indexOf('const SECRET_SETTING_KEYS'),
      source.indexOf('function maskSecretValue'),
    );
    expect(secretBlock).toContain("'CLAUDE_MEM_AIMLAPI_API_KEY'");
  });
});
