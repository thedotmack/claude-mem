import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildIsolatedEnv } from '../src/shared/EnvManager.js';
import { SettingsDefaultsManager } from '../src/shared/SettingsDefaultsManager.js';

const MODEL_OVERRIDES = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY',
];

const CLOUD_BACKENDS = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];

describe('observer model environment isolation (#5315)', () => {
  let dir: string;
  let original: Record<string, string | undefined>;
  let settingsSpy: ReturnType<typeof spyOn<typeof SettingsDefaultsManager, 'loadFromFile'>>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'claude-mem-model-env-'));
    const keys = [...MODEL_OVERRIDES, ...CLOUD_BACKENDS, 'CLAUDE_MEM_ENV_FILE', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'];
    original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    for (const key of CLOUD_BACKENDS) delete process.env[key];
    process.env.CLAUDE_MEM_ENV_FILE = join(dir, '.env');
    process.env.ANTHROPIC_BASE_URL = 'https://parent-gateway.example';
    process.env.ANTHROPIC_API_KEY = 'parent-key';
    for (const key of MODEL_OVERRIDES) process.env[key] = 'gateway-only-model';
    settingsSpy = spyOn(SettingsDefaultsManager, 'loadFromFile')
      .mockReturnValue(SettingsDefaultsManager.getAllDefaults());
  });

  afterEach(() => {
    settingsSpy.mockRestore();
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([true, false])('drops parent gateway models when no gateway is configured (credentials: %s)', includeCredentials => {
    const result = buildIsolatedEnv(includeCredentials);

    expect(result.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(result.ANTHROPIC_API_KEY).toBeUndefined();
    for (const key of MODEL_OVERRIDES) expect(result[key]).toBeUndefined();
    expect(result.PATH).toBe(process.env.PATH);
    for (const key of MODEL_OVERRIDES) expect(process.env[key]).toBe('gateway-only-model');
  });

  it('drops gateway models when the observer uses its own direct API key', () => {
    writeFileSync(join(dir, '.env'), 'ANTHROPIC_API_KEY=observer-key\n');

    const result = buildIsolatedEnv();

    expect(result.ANTHROPIC_API_KEY).toBe('observer-key');
    for (const key of MODEL_OVERRIDES) expect(result[key]).toBeUndefined();
  });

  it('retains model mappings for an explicitly configured observer gateway', () => {
    writeFileSync(join(dir, '.env'), 'ANTHROPIC_BASE_URL=https://observer-gateway.example\nANTHROPIC_AUTH_TOKEN=observer-token\n');

    const result = buildIsolatedEnv();

    expect(result.ANTHROPIC_BASE_URL).toBe('https://observer-gateway.example');
    expect(result.ANTHROPIC_AUTH_TOKEN).toBe('observer-token');
    for (const key of MODEL_OVERRIDES) expect(result[key]).toBe('gateway-only-model');
  });

  it('drops gateway model mappings when gateway credentials are excluded', () => {
    writeFileSync(join(dir, '.env'), 'ANTHROPIC_BASE_URL=https://observer-gateway.example\n');

    const result = buildIsolatedEnv(false);

    expect(result.ANTHROPIC_BASE_URL).toBeUndefined();
    for (const key of MODEL_OVERRIDES) expect(result[key]).toBeUndefined();
  });

  it.each(CLOUD_BACKENDS)('preserves cloud model mappings for %s', key => {
    process.env[key] = '1';

    const result = buildIsolatedEnv();

    expect(result[key]).toBe('1');
    for (const name of MODEL_OVERRIDES) expect(result[name]).toBe('gateway-only-model');
  });

  it.each(['0', 'false', ' FALSE ', ''])('a disabled cloud backend does not preserve gateway models (%s)', value => {
    process.env.CLAUDE_CODE_USE_BEDROCK = value;

    const result = buildIsolatedEnv();

    for (const key of MODEL_OVERRIDES) expect(result[key]).toBeUndefined();
  });
});
