import express from 'express';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { SettingsRoutes } from '../../../../src/services/worker/http/routes/SettingsRoutes.js';
import { resolveOpenAICompatConfig } from '../../../../src/services/worker/OpenAICompatProvider.js';
import { resolveOpenRouterConfig } from '../../../../src/services/worker/OpenRouterProvider.js';
import { paths } from '../../../../src/shared/paths.js';

const stored = {
  CLAUDE_MEM_OPENAI_COMPAT_BASE_URL: 'https://configured-compat.example/v1',
  CLAUDE_MEM_OPENAI_COMPAT_PRESET: 'deepseek',
  CLAUDE_MEM_OPENAI_COMPAT_API_KEY: 'fixture-compat-key',
  CLAUDE_MEM_OPENROUTER_BASE_URL: 'https://configured-router.example/v1',
  CLAUDE_MEM_OPENROUTER_API_KEY: 'fixture-router-key',
};
const redirected = {
  CLAUDE_MEM_OPENAI_COMPAT_BASE_URL: 'https://untrusted.example/compat',
  CLAUDE_MEM_OPENAI_COMPAT_PRESET: 'ollama',
  CLAUDE_MEM_OPENROUTER_BASE_URL: 'https://untrusted.example/router',
};
const envKeys = [...Object.keys(stored), 'OPENROUTER_BASE_URL'];

describe('provider endpoint settings stay under file/environment control', () => {
  const settingsPath = paths.settings();
  let previous: string | undefined;
  let previousEnv: Record<string, string | undefined>;
  let server: Server;
  let url: string;

  beforeEach(async () => {
    previous = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : undefined;
    previousEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
    for (const key of envKeys) delete process.env[key];
    writeFileSync(settingsPath, JSON.stringify(stored));
    const app = express();
    app.use(express.json());
    new SettingsRoutes({} as any).setupRoutes(app);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture has no TCP address');
    url = `http://127.0.0.1:${address.port}/api/settings`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (previous === undefined) rmSync(settingsPath, { force: true });
    else writeFileSync(settingsPath, previous);
    for (const key of envKeys) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
  });

  const disk = () => JSON.parse(readFileSync(settingsPath, 'utf8'));
  const post = (body: object) => fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const endpoints = () => ({
    compat: resolveOpenAICompatConfig(settingsPath).apiUrl,
    router: resolveOpenRouterConfig(settingsPath).apiUrl,
  });

  for (const wrapped of [false, true]) {
    it(`preserves configured destinations and keys during a whole-settings save (${wrapped ? 'wrapped' : 'flat'})`, async () => {
      writeFileSync(settingsPath, JSON.stringify(wrapped ? { env: stored, annotation: 'keep outer metadata' } : stored));
      const before = endpoints();
      const shown = await (await fetch(url)).json();
      const response = await post({ ...shown, ...redirected, CLAUDE_MEM_LOG_LEVEL: 'DEBUG', CLAUDE_MEM_OPENAI_COMPAT_MODEL: 'edited-model' });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ success: true, message: 'Settings updated successfully' });
      const document = disk();
      const settings = wrapped ? document.env : document;
      for (const [key, value] of Object.entries(stored)) expect(settings[key]).toBe(value);
      expect(settings.CLAUDE_MEM_LOG_LEVEL).toBe('DEBUG');
      expect(settings.CLAUDE_MEM_OPENAI_COMPAT_MODEL).toBe('edited-model');
      if (wrapped) expect(document.annotation).toBe('keep outer metadata');
      expect(endpoints()).toEqual(before);
    });
  }

  it('cannot install a destination or preset when none is configured', async () => {
    writeFileSync(settingsPath, '{}');
    expect((await post({ ...redirected, CLAUDE_MEM_LOG_LEVEL: 'DEBUG' })).status).toBe(200);
    const settings = disk();
    for (const key of Object.keys(redirected)) expect(settings[key]).toBeUndefined();
    expect(settings.CLAUDE_MEM_LOG_LEVEL).toBe('DEBUG');
  });

  it('cannot redirect a preset-derived destination when the explicit URL is empty', async () => {
    writeFileSync(settingsPath, JSON.stringify({ ...stored, CLAUDE_MEM_OPENAI_COMPAT_BASE_URL: '' }));
    const before = resolveOpenAICompatConfig(settingsPath);
    expect(before.apiUrl).toBe('https://api.deepseek.com/v1/chat/completions');
    expect((await post({ CLAUDE_MEM_OPENAI_COMPAT_PRESET: 'ollama' })).status).toBe(200);
    const after = resolveOpenAICompatConfig(settingsPath);
    expect(after.apiUrl).toBe(before.apiUrl);
    expect(after.apiKey).toBe(before.apiKey);
  });

  it('ignores malformed endpoint fields without rejecting an unrelated save', async () => {
    for (const value of ['not a URL', null, 123, { url: 'https://untrusted.example' }]) {
      const response = await post(Object.assign(
        Object.fromEntries(Object.keys(redirected).map(key => [key, value])),
        { CLAUDE_MEM_LOG_LEVEL: 'DEBUG' },
      ));
      expect(response.status).toBe(200);
      for (const [key, expected] of Object.entries(stored)) expect(disk()[key]).toBe(expected);
      expect(disk().CLAUDE_MEM_LOG_LEVEL).toBe('DEBUG');
    }
  });

  it('honors file edits and environment overrides without persisting a GET echo', async () => {
    const edited = { ...stored, CLAUDE_MEM_OPENAI_COMPAT_BASE_URL: '', CLAUDE_MEM_OPENAI_COMPAT_PRESET: 'groq' };
    writeFileSync(settingsPath, JSON.stringify(edited));
    expect(resolveOpenAICompatConfig(settingsPath).apiUrl).toBe('https://api.groq.com/openai/v1/chat/completions');
    process.env.CLAUDE_MEM_OPENAI_COMPAT_PRESET = 'together';
    expect(resolveOpenAICompatConfig(settingsPath).apiUrl).toBe('https://api.together.xyz/v1/chat/completions');
    process.env.CLAUDE_MEM_OPENAI_COMPAT_BASE_URL = 'https://env-compat.example/v1';
    process.env.CLAUDE_MEM_OPENROUTER_BASE_URL = 'https://env-router.example/v1';
    const shown = await (await fetch(url)).json();
    expect(shown.CLAUDE_MEM_OPENAI_COMPAT_BASE_URL).toBe(process.env.CLAUDE_MEM_OPENAI_COMPAT_BASE_URL);
    expect((await post({ ...shown, CLAUDE_MEM_LOG_LEVEL: 'DEBUG' })).status).toBe(200);
    expect(endpoints()).toEqual({ compat: 'https://env-compat.example/v1/chat/completions', router: 'https://env-router.example/v1/chat/completions' });
    for (const [key, value] of Object.entries(edited)) expect(disk()[key]).toBe(value);
    expect(disk().CLAUDE_MEM_LOG_LEVEL).toBe('DEBUG');
  });

  it('has no alternate PUT settings writer', async () => {
    const before = readFileSync(settingsPath, 'utf8');
    expect((await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(redirected) })).status).toBe(404);
    expect(readFileSync(settingsPath, 'utf8')).toBe(before);
  });
});
