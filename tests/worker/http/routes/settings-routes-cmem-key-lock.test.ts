import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { Request, Response } from 'express';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { SettingsRoutes } from '../../../../src/services/worker/http/routes/SettingsRoutes.js';
import { OpenRouterProvider } from '../../../../src/services/worker/OpenRouterProvider.js';
import { selectProviderForGenerator } from '../../../../src/services/worker/provider-dispatch.js';
import { paths } from '../../../../src/shared/paths.js';
import { logger } from '../../../../src/utils/logger.js';
import type { TelegramWrapupFormatterInput } from '../../../../src/services/integrations/TelegramWrapupNotifier.js';

/**
 * The account-owned cmem memory key (cm_pro_…) must never authenticate a
 * request to any host but the cmem gateway.
 *
 * The credential tuple lock only covered ENVIRONMENT overrides. The settings
 * API (the viewer) writes CLAUDE_MEM_OPENROUTER_BASE_URL straight into
 * settings.json, and the viewer posts the masked key back unchanged — so a
 * base-URL edit left the cm_pro key paired with the new host, and the next
 * request carried it there. These tests make the edit through the real POST
 * handler and then watch the wire of the real provider's request path.
 */

const GATEWAY_BASE_URL = 'https://cmem.ai/api/inference/v1';
const MEMORY_KEY = 'cm_pro_0123456789abcdef01234567';
const PERSONAL_KEY = 'sk-or-v1-personal-test-key';

const ENV_KEYS = [
  'CLAUDE_MEM_PROVIDER',
  'CLAUDE_MEM_OPENROUTER_API_KEY',
  'CLAUDE_MEM_OPENROUTER_BASE_URL',
  'CLAUDE_MEM_OPENROUTER_MODEL',
  'CLAUDE_MEM_PRO_FALLBACK_AT',
  'CLAUDE_MEM_GEMINI_API_KEY',
  'CMEM_PRO_ORIGIN',
  'OPENROUTER_BASE_URL',
] as const;

const wrapupInput: TelegramWrapupFormatterInput = {
  sessionDbId: 7,
  contentSessionId: 'content-7',
  project: 'cmem-key-lock-test',
  platformSource: 'claude',
  summaryText: 'request\ninvestigated\ncompleted',
};

/** The mask GET /api/settings returns, which the viewer posts back as-is. */
function viewerMask(value: string): string {
  return value.length <= 4 ? '*'.repeat(value.length) : `${'*'.repeat(value.length - 4)}${value.slice(-4)}`;
}

function capturePost(routes: SettingsRoutes): (req: Request, res: Response) => void {
  let postHandler!: (req: Request, res: Response) => void;
  routes.setupRoutes({
    get: mock(() => {}),
    post: mock((path: string, ...handlers: Array<(req: Request, res: Response) => void>) => {
      if (path === '/api/settings') postHandler = handlers[handlers.length - 1];
    }),
  } as any);
  return postHandler;
}

function postSettings(body: Record<string, string>): void {
  const json = mock(() => {});
  const status = mock(() => ({ json }));
  capturePost(new SettingsRoutes({} as any))(
    { body, headers: {}, path: '/api/settings', params: {}, query: {} } as unknown as Request,
    { json, status, headersSent: false } as unknown as Response,
  );
  expect(status).not.toHaveBeenCalled();
  expect(json).toHaveBeenCalledWith({ success: true, message: 'Settings updated successfully' });
}

describe('the cmem memory key stays with the cmem gateway', () => {
  const settingsPath = paths.settings();
  const realFetch = globalThis.fetch;
  let savedSettings: string | null = null;
  let savedEnv: Record<string, string | undefined> = {};
  let requests: Array<{ url: string; authorization: string | null }> = [];
  let loggerSpies: ReturnType<typeof spyOn>[] = [];

  beforeEach(() => {
    savedSettings = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf-8') : null;
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }

    writeFileSync(settingsPath, JSON.stringify({
      CLAUDE_MEM_PROVIDER: 'openrouter',
      CLAUDE_MEM_OPENROUTER_BASE_URL: GATEWAY_BASE_URL,
      CLAUDE_MEM_OPENROUTER_MODEL: 'cmem-observer',
      CLAUDE_MEM_OPENROUTER_API_KEY: MEMORY_KEY,
      CLAUDE_MEM_PRO_FALLBACK_AT: '',
    }, null, 2), 'utf-8');

    requests = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      requests.push({ url, authorization: new Headers(init?.headers).get('authorization') });
      return new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '• wrapped up' }, finish_reason: 'stop' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;

    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    loggerSpies.forEach(spy => spy.mockRestore());
    if (savedSettings === null) rmSync(settingsPath, { force: true });
    else writeFileSync(settingsPath, savedSettings, 'utf-8');
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it.each([
    ['another host', 'https://attacker.example/v1'],
    ['a gateway lookalike', 'https://cmem.ai.attacker.example/api/inference/v1'],
    ['the default openrouter.ai endpoint', ''],
  ])('is never sent to %s after a settings-API base-URL change', async (_label, newBaseUrl) => {
    // Exactly what the viewer's Save does: the edited field plus the masked
    // key echoed back from GET, which the API treats as "unchanged".
    postSettings({
      CLAUDE_MEM_OPENROUTER_BASE_URL: newBaseUrl,
      CLAUDE_MEM_OPENROUTER_API_KEY: viewerMask(MEMORY_KEY),
    });
    const persisted = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(persisted.CLAUDE_MEM_OPENROUTER_BASE_URL).toBe(newBaseUrl);
    expect(persisted.CLAUDE_MEM_OPENROUTER_API_KEY).toBe(MEMORY_KEY);

    const provider = new OpenRouterProvider({} as any, {} as any);
    await expect(provider.formatTelegramWrapup(wrapupInput)).rejects.toThrow('OpenRouter API key not configured');

    expect(requests.filter(request => request.authorization?.includes(MEMORY_KEY))).toEqual([]);
    // With no usable key the observer falls through to the Anthropic plan
    // instead of calling the new host with the account's credential.
    expect(selectProviderForGenerator()).toEqual({ provider: 'claude', gatewayProbeClaimId: null });
  });

  it('still reaches the gateway with the memory key when the base URL is untouched', async () => {
    postSettings({ CLAUDE_MEM_OPENROUTER_API_KEY: viewerMask(MEMORY_KEY) });

    const provider = new OpenRouterProvider({} as any, {} as any);
    await expect(provider.formatTelegramWrapup(wrapupInput)).resolves.toBe('• wrapped up');

    expect(requests).toEqual([{ url: `${GATEWAY_BASE_URL}/chat/completions`, authorization: `Bearer ${MEMORY_KEY}` }]);
  });

  it('never sends a personal key to the gateway (existing tuple lock)', async () => {
    process.env.CLAUDE_MEM_OPENROUTER_API_KEY = PERSONAL_KEY;
    const provider = new OpenRouterProvider({} as any, {} as any);

    await provider.formatTelegramWrapup(wrapupInput);
    expect(requests).toEqual([{ url: `${GATEWAY_BASE_URL}/chat/completions`, authorization: `Bearer ${MEMORY_KEY}` }]);

    // Gateway tuple with no stored key: fail closed rather than borrow it.
    postSettings({ CLAUDE_MEM_OPENROUTER_API_KEY: '' });
    requests = [];
    await expect(provider.formatTelegramWrapup(wrapupInput)).rejects.toThrow('OpenRouter API key not configured');
    expect(requests).toEqual([]);
  });
});
