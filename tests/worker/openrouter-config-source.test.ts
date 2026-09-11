// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  isOpenRouterAvailable,
  parseOpenRouterInt,
  resolveOpenRouterConfig,
} from '../../src/services/worker/OpenRouterProvider.js';
import { DEFAULT_OPENROUTER_API_URL } from '../../src/shared/openrouter-base-url.js';

const CMEM_BASE = 'https://cmem.ai/api/inference/v1';
const ENV_KEYS = [
  'CLAUDE_MEM_OPENROUTER_API_KEY',
  'CLAUDE_MEM_OPENROUTER_BASE_URL',
  'CLAUDE_MEM_OPENROUTER_MODEL',
  'OPENROUTER_BASE_URL',
  'CLAUDE_MEM_ENV_FILE',
  'CMEM_PRO_ORIGIN',
] as const;

describe('OpenRouter credential tuple source coherence', () => {
  let tempDir: string;
  let settingsPath: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tempDir = join(tmpdir(), `openrouter-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    settingsPath = join(tempDir, 'settings.json');
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.CLAUDE_MEM_ENV_FILE = join(tempDir, '.env');
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeSettings(overrides: Record<string, unknown> = {}): void {
    writeFileSync(settingsPath, JSON.stringify({
      CLAUDE_MEM_PROVIDER: 'openrouter',
      CLAUDE_MEM_OPENROUTER_API_KEY: 'cm_pro_persisted',
      CLAUDE_MEM_OPENROUTER_BASE_URL: CMEM_BASE,
      CLAUDE_MEM_OPENROUTER_MODEL: 'cmem-observer',
      ...overrides,
    }));
  }

  it('ignores a key-only environment override when a persisted CMEM tuple is active', () => {
    writeSettings();
    process.env.CLAUDE_MEM_OPENROUTER_API_KEY = 'PERSONAL_KEY_MUST_NOT_REACH_CMEM';

    const config = resolveOpenRouterConfig(settingsPath);

    expect(config.apiKey).toBe('cm_pro_persisted');
    expect(config.apiUrl).toBe(`${CMEM_BASE}/chat/completions`);
    expect(config.model).toBe('cmem-observer');
    expect(isOpenRouterAvailable(settingsPath)).toBe(true);
  });

  it('fails closed when CMEM has no persisted key instead of borrowing a personal env key', () => {
    writeSettings({ CLAUDE_MEM_OPENROUTER_API_KEY: '' });
    process.env.CLAUDE_MEM_OPENROUTER_API_KEY = 'PERSONAL_KEY_MUST_NOT_REACH_CMEM';
    writeFileSync(process.env.CLAUDE_MEM_ENV_FILE!, 'OPENROUTER_API_KEY=PERSONAL_ENV_FILE_KEY\n');

    const config = resolveOpenRouterConfig(settingsPath);

    expect(config.apiKey).toBe('');
    expect(config.apiUrl).toBe(`${CMEM_BASE}/chat/completions`);
    expect(isOpenRouterAvailable(settingsPath)).toBe(false);
  });

  it('accepts a personal key when the base is explicitly reset and restores the normal model', () => {
    writeSettings();
    process.env.CLAUDE_MEM_OPENROUTER_API_KEY = 'sk-or-personal';
    process.env.CLAUDE_MEM_OPENROUTER_BASE_URL = '';

    const config = resolveOpenRouterConfig(settingsPath);

    expect(config.apiKey).toBe('sk-or-personal');
    expect(config.apiUrl).toBe(DEFAULT_OPENROUTER_API_URL);
    expect(config.model).toBe('xiaomi/mimo-v2-flash:free');
  });

  it('fails closed when the CMEM base is reset without a personal key', () => {
    writeSettings();
    process.env.CLAUDE_MEM_OPENROUTER_BASE_URL = '';

    const config = resolveOpenRouterConfig(settingsPath);

    expect(config.apiKey).toBe('');
    expect(config.apiUrl).toBe(DEFAULT_OPENROUTER_API_URL);
    expect(config.model).toBe('xiaomi/mimo-v2-flash:free');
    expect(isOpenRouterAvailable(settingsPath)).toBe(false);
  });

  it('uses the personal env-file key for a base-only override, never the persisted CMEM key', () => {
    writeSettings();
    process.env.CLAUDE_MEM_OPENROUTER_BASE_URL = 'https://gateway.example/v1';
    writeFileSync(process.env.CLAUDE_MEM_ENV_FILE!, 'OPENROUTER_API_KEY=personal-env-file-key\n');

    expect(resolveOpenRouterConfig(settingsPath)).toMatchObject({
      apiKey: 'personal-env-file-key',
      apiUrl: 'https://gateway.example/v1/chat/completions',
      model: 'xiaomi/mimo-v2-flash:free',
    });
  });

  it('fails closed for a custom base-only override without a personal key', () => {
    writeSettings();
    process.env.CLAUDE_MEM_OPENROUTER_BASE_URL = 'https://gateway.example/v1';

    const config = resolveOpenRouterConfig(settingsPath);

    expect(config.apiKey).toBe('');
    expect(config.apiUrl).toBe('https://gateway.example/v1/chat/completions');
    expect(config.model).toBe('xiaomi/mimo-v2-flash:free');
    expect(isOpenRouterAvailable(settingsPath)).toBe(false);
  });

  it('accepts an explicit replacement tuple, including a custom model', () => {
    writeSettings();
    process.env.CLAUDE_MEM_OPENROUTER_API_KEY = 'custom-key';
    process.env.CLAUDE_MEM_OPENROUTER_BASE_URL = 'https://gateway.example/v1';
    process.env.CLAUDE_MEM_OPENROUTER_MODEL = 'custom-model';

    expect(resolveOpenRouterConfig(settingsPath)).toMatchObject({
      apiKey: 'custom-key',
      apiUrl: 'https://gateway.example/v1/chat/completions',
      model: 'custom-model',
    });
  });

  it('does not treat a deceptive CMEM hostname as an account-owned tuple', () => {
    writeSettings({
      CLAUDE_MEM_OPENROUTER_API_KEY: 'custom-persisted-key',
      CLAUDE_MEM_OPENROUTER_BASE_URL: 'https://cmem.ai.evil.example/v1',
      CLAUDE_MEM_OPENROUTER_MODEL: 'custom-model',
    });
    process.env.CLAUDE_MEM_OPENROUTER_API_KEY = 'custom-env-key';

    expect(resolveOpenRouterConfig(settingsPath)).toMatchObject({
      apiKey: 'custom-env-key',
      apiUrl: 'https://cmem.ai.evil.example/v1/chat/completions',
      model: 'custom-model',
    });
  });
});

describe('OpenRouter numeric setting parsing (#3868)', () => {
  let tempDir: string;
  let settingsPath: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tempDir = join(tmpdir(), `openrouter-int-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    settingsPath = join(tempDir, 'settings.json');
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.CLAUDE_MEM_ENV_FILE = join(tempDir, '.env');
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * attemptTimeoutMs (min 1, default 30000) exercises the min>=1 fallback
   * cases; maxContextMessages (min 0, default 40) exercises the "0 is a
   * legitimate value, only negative falls back" cases documented beside
   * parseOpenRouterInt.
   */
  function configFor(attemptTimeoutMsRaw: unknown, maxContextMessagesRaw?: unknown): { attemptTimeoutMs: number; maxContextMessages: number } {
    writeFileSync(settingsPath, JSON.stringify({
      CLAUDE_MEM_OPENROUTER_ATTEMPT_TIMEOUT_MS: attemptTimeoutMsRaw,
      ...(maxContextMessagesRaw !== undefined ? { CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES: maxContextMessagesRaw } : {}),
    }));
    const config = resolveOpenRouterConfig(settingsPath);
    return { attemptTimeoutMs: config.attemptTimeoutMs, maxContextMessages: config.maxContextMessages };
  }

  it('rejects a numeric-prefix string like "1e3" instead of silently truncating it to 1 (the reported 1ms-timeout bug)', () => {
    // parseInt("1e3", 10) === 1, which used to pass the min-1 check and turn
    // a 1000ms timeout into a 1ms one. The fixed parser must reject the whole
    // string as non-integral and fall back to the documented default.
    expect(configFor('1e3').attemptTimeoutMs).toBe(30000);
  });

  it('rejects a non-integral decimal string like "42.5"', () => {
    expect(configFor('42.5').attemptTimeoutMs).toBe(30000);
  });

  it('rejects a hex-looking string like "0x10"', () => {
    expect(configFor('0x10').attemptTimeoutMs).toBe(30000);
  });

  it('accepts a valid integer string with surrounding whitespace trimmed', () => {
    expect(configFor(' 5000 ').attemptTimeoutMs).toBe(5000);
  });

  it('rejects a negative value below the minimum and falls back to the default', () => {
    expect(configFor('-5').attemptTimeoutMs).toBe(30000);
  });

  it('rejects an empty string', () => {
    expect(configFor('').attemptTimeoutMs).toBe(30000);
  });

  it('rejects a non-numeric string like "abc"', () => {
    expect(configFor('abc').attemptTimeoutMs).toBe(30000);
  });

  it('rejects "0" for a min-1 key (attemptTimeoutMs) but accepts "0" for a min-0 key (maxContextMessages)', () => {
    const config = configFor('0', '0');
    expect(config.attemptTimeoutMs).toBe(30000);
    expect(config.maxContextMessages).toBe(0);
  });

  it('accepts a plain valid integer value unchanged', () => {
    expect(configFor('12345').attemptTimeoutMs).toBe(12345);
  });

  it('accepts an actual finite integral JSON number, not just a string', () => {
    expect(configFor(5000).attemptTimeoutMs).toBe(5000);
  });

  it('rejects a non-integral JSON number like 42.5', () => {
    expect(configFor(42.5).attemptTimeoutMs).toBe(30000);
  });

  it('rejects an object value', () => {
    expect(configFor({ not: 'a number' }).attemptTimeoutMs).toBe(30000);
  });

  // NaN/Infinity can't round-trip through settings.json (JSON.stringify
  // coerces both to `null`, and literal `NaN`/`Infinity` tokens aren't valid
  // JSON), so these call parseOpenRouterInt directly rather than through the
  // file-backed resolveOpenRouterConfig used above.
  it('rejects non-finite numbers (NaN, Infinity) passed directly', () => {
    expect(parseOpenRouterInt(NaN, 30000, 1)).toBe(30000);
    expect(parseOpenRouterInt(Infinity, 30000, 1)).toBe(30000);
    expect(parseOpenRouterInt(-Infinity, 30000, 1)).toBe(30000);
  });

  // A JSON string, unlike a literal NaN/Infinity token, round-trips through
  // settings.json without issue — this is the realistic path (a corrupt
  // settings value or an env var) that reaches parseOpenRouterInt's string
  // branch. `Number('999…9')` for a numeral this long overflows to
  // `Infinity` rather than throwing, so without a finiteness check on the
  // parsed result, `Infinity < min` is false and the huge value would pass
  // straight through instead of falling back — reintroducing the same
  // "silently becomes ~1ms once it hits setTimeout" failure this guard
  // exists to prevent.
  it('rejects a numeral long enough to overflow Number() to Infinity', () => {
    const overflowingNumeral = '9'.repeat(320);
    expect(configFor(overflowingNumeral).attemptTimeoutMs).toBe(30000);
    expect(parseOpenRouterInt(overflowingNumeral, 30000, 1)).toBe(30000);
  });

  // attemptTimeoutMs is handed to `setTimeout` (retry.ts), which silently
  // clamps any delay over 2^31-1 ms to fire after ~1ms instead — so an
  // ordinary finite, in-range-per-`min` value that is still too large for
  // `setTimeout` (e.g. a fat-fingered extra zero) must fall back too, not
  // just non-numeric or overflowing-to-Infinity input.
  it("rejects a finite value that exceeds setTimeout's 32-bit ceiling and falls back to the default", () => {
    expect(configFor(5_000_000_000).attemptTimeoutMs).toBe(30000);
    expect(configFor('5000000000').attemptTimeoutMs).toBe(30000);
  });

  it("accepts a finite value at exactly setTimeout's 32-bit ceiling", () => {
    expect(configFor(2_147_483_647).attemptTimeoutMs).toBe(2_147_483_647);
  });

  it('has no upper bound on a key with no explicit max (maxContextMessages), only on attemptTimeoutMs', () => {
    // maxContextMessages never reaches setTimeout, so parseOpenRouterInt's
    // default max (Number.MAX_SAFE_INTEGER) is the only ceiling — an
    // ordinary large-but-safe integer must pass through unchanged.
    expect(parseOpenRouterInt(5_000_000_000, 40, 0)).toBe(5_000_000_000);
  });
});
