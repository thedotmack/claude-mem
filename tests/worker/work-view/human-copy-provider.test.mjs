import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuredHumanCopyProvider } from '../../../src/services/worker/http/routes/WorkViewRoutes.js';

const ENV_KEYS = [
  'CLAUDE_MEM_PROVIDER', 'CLAUDE_MEM_WORK_VIEW_COPY_PROVIDER', 'CLAUDE_MEM_WORK_VIEW_COPY_MODEL',
  'CLAUDE_MEM_OPENROUTER_API_KEY', 'CLAUDE_MEM_OPENROUTER_BASE_URL', 'CLAUDE_MEM_OPENROUTER_MODEL',
  'OPENROUTER_API_KEY', 'OPENROUTER_BASE_URL', 'CLAUDE_MEM_OPENAI_COMPAT_API_KEY',
  'CLAUDE_MEM_OPENAI_COMPAT_BASE_URL', 'CLAUDE_MEM_OPENAI_COMPAT_MODEL', 'CLAUDE_MEM_OPENAI_COMPAT_PRESET',
  'OPENAI_COMPAT_API_KEY',
];

function isolateSettings(t) {
  const previous = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  const directory = mkdtempSync(join(tmpdir(), 'human-copy-provider-'));
  const settingsPath = join(directory, 'settings.json');
  t.after(() => {
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    rmSync(directory, { recursive: true, force: true });
  });
  return { settingsPath, save: settings => writeFileSync(settingsPath, JSON.stringify(settings)) };
}

function mockFetch(t) {
  const previous = globalThis.fetch;
  let sent;
  globalThis.fetch = async (url, init) => {
    sent = { url, init };
    return new Response(JSON.stringify({ model: 'response-model', choices: [{ message: { content: '{"title":"Readable"}' } }] }));
  };
  t.after(() => { globalThis.fetch = previous; });
  return () => sent;
}

test('an unused OpenRouter fallback key stays idle until selected; settings resolve after route construction', async t => {
  const { settingsPath, save } = isolateSettings(t);
  const sent = mockFetch(t);
  save({
    CLAUDE_MEM_PROVIDER: 'claude',
    CLAUDE_MEM_WORK_VIEW_COPY_PROVIDER: '',
    CLAUDE_MEM_OPENROUTER_API_KEY: 'fallback-key',
    CLAUDE_MEM_OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
    CLAUDE_MEM_OPENROUTER_MODEL: 'observer-model',
  });
  const provider = configuredHumanCopyProvider(settingsPath);
  assert.equal(provider.isAvailable(), false);

  save({
    CLAUDE_MEM_PROVIDER: 'claude',
    CLAUDE_MEM_WORK_VIEW_COPY_PROVIDER: 'openrouter',
    CLAUDE_MEM_WORK_VIEW_COPY_MODEL: 'copy-model',
    CLAUDE_MEM_OPENROUTER_API_KEY: 'fallback-key',
    CLAUDE_MEM_OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
    CLAUDE_MEM_OPENROUTER_MODEL: 'observer-model',
  });
  assert.equal(provider.isAvailable(), true);
  const result = await provider({ request: 'presentation only' });
  assert.deepEqual(result.output, { title: 'Readable' });
  assert.equal(sent().url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(sent().init.headers.Authorization, 'Bearer fallback-key');
  assert.equal(JSON.parse(sent().init.body).model, 'copy-model');
});

test('an unset setting follows the primary OpenAI-compatible provider and its model', async t => {
  const { settingsPath, save } = isolateSettings(t);
  const sent = mockFetch(t);
  save({
    CLAUDE_MEM_PROVIDER: 'openai-compatible',
    CLAUDE_MEM_WORK_VIEW_COPY_PROVIDER: '',
    CLAUDE_MEM_OPENAI_COMPAT_BASE_URL: 'https://compat.example.test/v1',
    CLAUDE_MEM_OPENAI_COMPAT_API_KEY: 'compat-key',
    CLAUDE_MEM_OPENAI_COMPAT_MODEL: 'compat-model',
  });
  const provider = configuredHumanCopyProvider(settingsPath);
  assert.equal(provider.isAvailable(), true);
  await provider({ request: 'presentation only' });
  assert.equal(sent().url, 'https://compat.example.test/v1/chat/completions');
  assert.equal(sent().init.headers.Authorization, 'Bearer compat-key');
  assert.equal(JSON.parse(sent().init.body).model, 'compat-model');
});

test('off disables copy even when the primary provider is configured', t => {
  const { settingsPath, save } = isolateSettings(t);
  save({
    CLAUDE_MEM_PROVIDER: 'openrouter',
    CLAUDE_MEM_WORK_VIEW_COPY_PROVIDER: 'off',
    CLAUDE_MEM_OPENROUTER_API_KEY: 'primary-key',
    CLAUDE_MEM_OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
    CLAUDE_MEM_OPENROUTER_MODEL: 'observer-model',
  });
  assert.equal(configuredHumanCopyProvider(settingsPath).isAvailable(), false);
});
