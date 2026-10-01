// Contract: the cmem.ai memory key (cm_pro_…) goes only to the cmem gateway
// (#4276, isKeyAllowedForEndpoint). Codex authenticates with the user's own
// ChatGPT login through the Codex CLI, so no Codex path may carry that key:
// not the app-server child's environment, not a request, and not the settings
// written when Codex is selected, which must leave the gateway configuration
// as it was for a switch back.
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { Request, Response } from 'express';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { buildCodexAppServerEnv } from '../../src/services/worker/CodexAppServerClient.js';
import { CodexProvider } from '../../src/services/worker/CodexProvider.js';
import { SettingsRoutes } from '../../src/services/worker/http/routes/SettingsRoutes.js';
import { paths } from '../../src/shared/paths.js';

const CMEM_KEY = 'cm_pro_0123456789abcdef01234567';
const GATEWAY_URL = 'https://cmem.ai/api/v1';

function postSettings(body: Record<string, unknown>): ReturnType<typeof mock> {
  let handler!: (req: Request, res: Response) => void;
  const app: any = {
    get: mock(() => {}),
    post: mock((path: string, ...handlers: Array<(req: Request, res: Response) => void>) => {
      if (path === '/api/settings') handler = handlers[handlers.length - 1];
    }),
  };
  new SettingsRoutes({} as any).setupRoutes(app);
  const json = mock(() => {});
  const res = { json, status: mock(() => ({ json })), headersSent: false } as unknown as Response;
  handler({ body, path: '/api/settings', params: {}, query: {}, headers: {} } as Request, res);
  return json;
}

describe('Codex never carries the cmem gateway key', () => {
  const settingsPath = paths.settings();
  let prior: string | undefined;
  let savedProvider: string | undefined;

  beforeEach(() => {
    prior = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf-8') : undefined;
    savedProvider = process.env.CLAUDE_MEM_PROVIDER;
    delete process.env.CLAUDE_MEM_PROVIDER;
    // A Pro install: memory on the gateway, with its account-delivered key.
    writeFileSync(settingsPath, JSON.stringify({
      CLAUDE_MEM_PROVIDER: 'openrouter',
      CLAUDE_MEM_OPENROUTER_BASE_URL: GATEWAY_URL,
      CLAUDE_MEM_OPENROUTER_API_KEY: CMEM_KEY,
    }));
  });

  afterEach(() => {
    if (prior === undefined) rmSync(settingsPath, { force: true });
    else writeFileSync(settingsPath, prior, 'utf-8');
    if (savedProvider === undefined) delete process.env.CLAUDE_MEM_PROVIDER;
    else process.env.CLAUDE_MEM_PROVIDER = savedProvider;
  });

  it('gives the app-server child no claude-mem or provider credential from the environment', () => {
    const env = buildCodexAppServerEnv({
      PATH: '/usr/bin',
      HOME: '/home/user',
      CLAUDE_MEM_OPENROUTER_API_KEY: CMEM_KEY,
      CLAUDE_MEM_OPENROUTER_BASE_URL: GATEWAY_URL,
      OPENROUTER_API_KEY: CMEM_KEY,
      OPENAI_API_KEY: CMEM_KEY,
      ANTHROPIC_API_KEY: CMEM_KEY,
    }, join('/private', 'codex-home'));
    expect(Object.values(env)).not.toContain(CMEM_KEY);
    expect(Object.keys(env).sort()).toEqual(['CODEX_HOME', 'HOME', 'PATH']);
  });

  it('sends no claude-mem credential with a Codex request, whatever the gateway settings hold', async () => {
    writeFileSync(settingsPath, JSON.stringify({
      CLAUDE_MEM_PROVIDER: 'codex',
      CLAUDE_MEM_OPENROUTER_BASE_URL: GATEWAY_URL,
      CLAUDE_MEM_OPENROUTER_API_KEY: CMEM_KEY,
    }));
    const provider = new CodexProvider(null as any, null as any) as any;
    const config = provider.getConfig();
    expect(JSON.stringify(config)).not.toContain(CMEM_KEY);
    const runTurn = mock(async (_options: unknown) => ({ content: 'ok' }));
    provider.appServer.runTurn = runTurn;
    await provider.query([{ role: 'user', content: 'observe' }], config);
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(runTurn.mock.calls[0][0])).not.toContain(CMEM_KEY);
  });

  it('selecting Codex in the viewer keeps the gateway configuration untouched for a switch back', () => {
    const json = postSettings({ CLAUDE_MEM_PROVIDER: 'codex', CLAUDE_MEM_CODEX_MODEL: 'gpt-6-luna' });
    expect(json).toHaveBeenCalledWith({ success: true, message: 'Settings updated successfully' });
    const persisted = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const flat = { ...persisted, ...(persisted.env ?? {}) };
    expect(flat.CLAUDE_MEM_PROVIDER).toBe('codex');
    expect(flat.CLAUDE_MEM_OPENROUTER_BASE_URL).toBe(GATEWAY_URL);
    expect(flat.CLAUDE_MEM_OPENROUTER_API_KEY).toBe(CMEM_KEY);
    // The key was not copied into any Codex setting.
    for (const [key, value] of Object.entries(flat)) {
      if (key.startsWith('CLAUDE_MEM_CODEX_')) expect(value).not.toBe(CMEM_KEY);
    }
  });

  it('the installer\'s --provider codex branch writes only the provider and the model', () => {
    const installSource = readFileSync(join(__dirname, '..', '..', 'src', 'npx-cli', 'commands', 'install.ts'), 'utf-8');
    const start = installSource.indexOf("if (selectedProvider === 'codex') {");
    expect(start).toBeGreaterThan(-1);
    const branch = installSource.slice(start, installSource.indexOf("return 'codex';", start));
    const written = branch.slice(branch.indexOf('mergeSettings({'), branch.indexOf('});', branch.indexOf('mergeSettings({')));
    expect(written).toContain("CLAUDE_MEM_PROVIDER: 'codex'");
    expect(written).toContain('CLAUDE_MEM_CODEX_MODEL');
    expect(written).not.toMatch(/OPENROUTER|PRO_|API_KEY|BASE_URL/);
  });
});
