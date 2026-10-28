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
  'OPENAI_COMPAT_API_KEY', 'CLAUDE_MEM_OPENAI_COMPAT_REASONING',
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
  const disabledConfigKey = provider.getConfigKey();

  save({
    CLAUDE_MEM_PROVIDER: 'claude',
    CLAUDE_MEM_WORK_VIEW_COPY_PROVIDER: 'openrouter',
    CLAUDE_MEM_WORK_VIEW_COPY_MODEL: 'copy-model',
    CLAUDE_MEM_OPENROUTER_API_KEY: 'fallback-key',
    CLAUDE_MEM_OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
    CLAUDE_MEM_OPENROUTER_MODEL: 'observer-model',
  });
  assert.equal(provider.isAvailable(), true);
  const selectedConfigKey = provider.getConfigKey();
  assert.notEqual(selectedConfigKey, disabledConfigKey);
  assert.equal(selectedConfigKey.includes('fallback-key'), false);
  const result = await provider({ request: 'presentation only' });
  assert.deepEqual(result.output, { title: 'Readable' });
  assert.equal(sent().url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(sent().init.headers.Authorization, 'Bearer fallback-key');
  assert.equal(JSON.parse(sent().init.body).model, 'copy-model');
  assert.equal(Object.hasOwn(JSON.parse(sent().init.body), 'models'), false);

  save({
    CLAUDE_MEM_PROVIDER: 'claude',
    CLAUDE_MEM_WORK_VIEW_COPY_PROVIDER: 'openrouter',
    CLAUDE_MEM_WORK_VIEW_COPY_MODEL: 'updated-copy-model',
    CLAUDE_MEM_OPENROUTER_API_KEY: 'fallback-key',
    CLAUDE_MEM_OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
    CLAUDE_MEM_OPENROUTER_MODEL: 'observer-model',
  });
  assert.notEqual(provider.getConfigKey(), selectedConfigKey);
  await provider({ request: 'after settings save' });
  assert.equal(JSON.parse(sent().init.body).model, 'updated-copy-model');
});

test('OpenRouter summary uses the configured model fallback list only for the official endpoint', async t => {
  const { settingsPath, save } = isolateSettings(t);
  const sent = mockFetch(t);
  save({
    CLAUDE_MEM_PROVIDER: 'openrouter',
    CLAUDE_MEM_WORK_VIEW_COPY_PROVIDER: 'openrouter',
    CLAUDE_MEM_OPENROUTER_API_KEY: 'fallback-key',
    CLAUDE_MEM_OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
    CLAUDE_MEM_OPENROUTER_MODEL: 'first-model,second-model,third-model',
  });
  await configuredHumanCopyProvider(settingsPath)({ request: 'presentation only' });
  const body = JSON.parse(sent().init.body);
  assert.deepEqual(body.models, ['first-model', 'second-model', 'third-model']);
  assert.equal(Object.hasOwn(body, 'model'), false);

  save({
    CLAUDE_MEM_PROVIDER: 'openrouter',
    CLAUDE_MEM_WORK_VIEW_COPY_PROVIDER: 'openrouter',
    CLAUDE_MEM_OPENROUTER_API_KEY: 'fallback-key',
    CLAUDE_MEM_OPENROUTER_BASE_URL: 'https://compat.example.test/v1',
    CLAUDE_MEM_OPENROUTER_MODEL: 'first-model,second-model',
  });
  await configuredHumanCopyProvider(settingsPath)({ request: 'presentation only' });
  const compatibleBody = JSON.parse(sent().init.body);
  assert.equal(compatibleBody.model, 'first-model');
  assert.equal(Object.hasOwn(compatibleBody, 'models'), false);
});

test('an unset setting keeps today\'s behaviour: an OpenAI-compatible primary writes no wording until selected', async t => {
  const { settingsPath, save } = isolateSettings(t);
  const sent = mockFetch(t);
  const compat = {
    CLAUDE_MEM_PROVIDER: 'openai-compatible',
    CLAUDE_MEM_OPENAI_COMPAT_BASE_URL: 'https://compat.example.test/v1',
    CLAUDE_MEM_OPENAI_COMPAT_API_KEY: 'compat-key',
    CLAUDE_MEM_OPENAI_COMPAT_MODEL: 'compat-model',
  };
  save({ ...compat, CLAUDE_MEM_WORK_VIEW_COPY_PROVIDER: '' });
  const provider = configuredHumanCopyProvider(settingsPath);
  assert.equal(provider.isAvailable(), false);
  assert.equal(sent(), undefined);

  save({ ...compat, CLAUDE_MEM_WORK_VIEW_COPY_PROVIDER: 'openai-compatible' });
  assert.equal(provider.isAvailable(), true);
  await provider({ request: 'presentation only' });
  assert.equal(sent().url, 'https://compat.example.test/v1/chat/completions');
  assert.equal(sent().init.headers.Authorization, 'Bearer compat-key');
  const body = JSON.parse(sent().init.body);
  assert.equal(body.model, 'compat-model');
  // CLAUDE_MEM_OPENAI_COMPAT_REASONING defaults to off, so the field that turns reasoning off is sent.
  assert.deepEqual(body.reasoning, { enabled: false });

  // With reasoning on for this endpoint, card wording leaves the field out too.
  save({ ...compat, CLAUDE_MEM_WORK_VIEW_COPY_PROVIDER: 'openai-compatible', CLAUDE_MEM_OPENAI_COMPAT_REASONING: 'on' });
  await provider({ request: 'presentation only' });
  assert.equal(Object.hasOwn(JSON.parse(sent().init.body), 'reasoning'), false);
});

test('a copy-model override works for an endpoint with no observer model', async t => {
  const { settingsPath, save } = isolateSettings(t);
  const sent = mockFetch(t);
  save({
    CLAUDE_MEM_PROVIDER: 'claude',
    CLAUDE_MEM_WORK_VIEW_COPY_PROVIDER: 'openai-compatible',
    CLAUDE_MEM_WORK_VIEW_COPY_MODEL: 'copy-only-model',
    CLAUDE_MEM_OPENAI_COMPAT_BASE_URL: 'https://compat.example.test/v1',
    CLAUDE_MEM_OPENAI_COMPAT_API_KEY: 'compat-key',
    CLAUDE_MEM_OPENAI_COMPAT_MODEL: '',
  });
  const provider = configuredHumanCopyProvider(settingsPath);
  assert.equal(provider.isAvailable(), true);
  await provider({ request: 'presentation only' });
  assert.equal(JSON.parse(sent().init.body).model, 'copy-only-model');
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
  const provider = configuredHumanCopyProvider(settingsPath);
  assert.equal(provider.isAvailable(), false);
  assert.equal(provider.isOff(), true);
});
