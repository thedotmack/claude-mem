
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, statSync, chmodSync, symlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { readFlatSettings } from '../../src/npx-cli/utils/settings.js';
import { DEFAULT_SETTINGS as VIEWER_DEFAULT_SETTINGS } from '../../src/ui/viewer/constants/settings.js';

/** Run `run` and collect every console.warn line it printed (the migration log channel). */
function captureWarnings<T>(run: () => T): { value: T; warnings: string[] } {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  try {
    return { value: run(), warnings };
  } finally {
    console.warn = originalWarn;
  }
}

describe('SettingsDefaultsManager', () => {
  let tempDir: string;
  let settingsPath: string;
  let savedDefaultKeyEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tempDir = join(tmpdir(), `settings-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    settingsPath = join(tempDir, 'settings.json');

    // loadFromFile applies env overrides on top of file/defaults, so ANY
    // settings-default key present in process.env makes its result diverge
    // from getAllDefaults(). On a dev machine this is not just the
    // CLAUDE_MEM_DATA_DIR pinned by the preload tripwire (tests/preload.ts) —
    // a running claude-mem install also exports e.g. CLAUDE_MEM_API_TIMEOUT_MS,
    // which silently broke these tests on contributor boxes while passing in a
    // clean CI env. These tests cover file > defaults behavior on an EXPLICIT
    // settingsPath (no real data-dir I/O), so strip EVERY default key from the
    // env for their duration and restore after — robust to whichever
    // CLAUDE_MEM_* vars the host happens to export.
    savedDefaultKeyEnv = {};
    for (const key of Object.keys(SettingsDefaultsManager.getAllDefaults())) {
      savedDefaultKeyEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedDefaultKeyEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('loadFromFile', () => {
    describe('file does not exist', () => {
      it('should create file with defaults when file does not exist', () => {
        expect(existsSync(settingsPath)).toBe(false);

        const result = SettingsDefaultsManager.loadFromFile(settingsPath);

        expect(existsSync(settingsPath)).toBe(true);
        expect(result).toEqual(SettingsDefaultsManager.getAllDefaults());
      });

      it('should write valid JSON to the created file', () => {
        SettingsDefaultsManager.loadFromFile(settingsPath);

        const content = readFileSync(settingsPath, 'utf-8');
        expect(() => JSON.parse(content)).not.toThrow();
      });

      it('should create the settings file as owner-readable only', () => {
        if (process.platform === 'win32') return;
        SettingsDefaultsManager.loadFromFile(settingsPath);
        expect(statSync(settingsPath).mode & 0o777).toBe(0o600);
      });

      it('should write pretty-printed JSON (2-space indent)', () => {
        SettingsDefaultsManager.loadFromFile(settingsPath);

        const content = readFileSync(settingsPath, 'utf-8');
        expect(content).toContain('\n');
        expect(content).toContain('  "CLAUDE_MEM_MODEL"');
      });

      it('should write all default keys to the file', () => {
        SettingsDefaultsManager.loadFromFile(settingsPath);

        const content = readFileSync(settingsPath, 'utf-8');
        const parsed = JSON.parse(content);
        const defaults = SettingsDefaultsManager.getAllDefaults();

        for (const key of Object.keys(defaults)) {
          expect(parsed).toHaveProperty(key);
        }
      });
    });

    describe('directory does not exist', () => {
      it('should create directory and file when parent directory does not exist', () => {
        const nestedPath = join(tempDir, 'nested', 'deep', 'settings.json');
        expect(existsSync(join(tempDir, 'nested'))).toBe(false);

        const result = SettingsDefaultsManager.loadFromFile(nestedPath);

        expect(existsSync(join(tempDir, 'nested', 'deep'))).toBe(true);
        expect(existsSync(nestedPath)).toBe(true);
        expect(result).toEqual(SettingsDefaultsManager.getAllDefaults());
      });

      it('should create deeply nested directories recursively', () => {
        const deepPath = join(tempDir, 'a', 'b', 'c', 'd', 'e', 'settings.json');

        SettingsDefaultsManager.loadFromFile(deepPath);

        expect(existsSync(join(tempDir, 'a', 'b', 'c', 'd', 'e'))).toBe(true);
        expect(existsSync(deepPath)).toBe(true);
      });
    });

    describe('file exists with valid content', () => {
      it('should return parsed content when file has valid JSON', () => {
        const customSettings = {
          CLAUDE_MEM_MODEL: 'custom-model',
          CLAUDE_MEM_WORKER_PORT: '12345',
        };
        writeFileSync(settingsPath, JSON.stringify(customSettings));

        const result = SettingsDefaultsManager.loadFromFile(settingsPath);

        expect(result.CLAUDE_MEM_MODEL).toBe('custom-model');
        expect(result.CLAUDE_MEM_WORKER_PORT).toBe('12345');
      });

      it('should merge file settings with defaults for missing keys', () => {
        const partialSettings = {
          CLAUDE_MEM_MODEL: 'partial-model',
        };
        writeFileSync(settingsPath, JSON.stringify(partialSettings));

        const result = SettingsDefaultsManager.loadFromFile(settingsPath);
        const defaults = SettingsDefaultsManager.getAllDefaults();

        expect(result.CLAUDE_MEM_MODEL).toBe('partial-model');
        expect(result.CLAUDE_MEM_WORKER_PORT).toBe(defaults.CLAUDE_MEM_WORKER_PORT);
        expect(result.CLAUDE_MEM_WORKER_HOST).toBe(defaults.CLAUDE_MEM_WORKER_HOST);
        expect(result.CLAUDE_MEM_LOG_LEVEL).toBe(defaults.CLAUDE_MEM_LOG_LEVEL);
      });

      it('should not modify existing file when loading', () => {
        const customSettings = {
          CLAUDE_MEM_MODEL: 'do-not-change',
          CUSTOM_KEY: 'should-persist', // Extra key not in defaults
        };
        writeFileSync(settingsPath, JSON.stringify(customSettings, null, 2));
        const originalContent = readFileSync(settingsPath, 'utf-8');

        SettingsDefaultsManager.loadFromFile(settingsPath);

        const afterContent = readFileSync(settingsPath, 'utf-8');
        expect(afterContent).toBe(originalContent);
      });

      it('should handle all settings keys correctly', () => {
        const fullSettings = SettingsDefaultsManager.getAllDefaults();
        fullSettings.CLAUDE_MEM_MODEL = 'all-keys-model';
        fullSettings.CLAUDE_MEM_PROVIDER = 'gemini';
        writeFileSync(settingsPath, JSON.stringify(fullSettings));

        const result = SettingsDefaultsManager.loadFromFile(settingsPath);

        expect(result.CLAUDE_MEM_MODEL).toBe('all-keys-model');
        expect(result.CLAUDE_MEM_PROVIDER).toBe('gemini');
      });
    });

    describe('file exists but is empty or corrupt', () => {
      it('should return defaults when file is empty', () => {
        writeFileSync(settingsPath, '');

        const result = SettingsDefaultsManager.loadFromFile(settingsPath);

        expect(result).toEqual(SettingsDefaultsManager.getAllDefaults());
      });

      it('should return defaults when file contains invalid JSON', () => {
        writeFileSync(settingsPath, 'not valid json {{{{');

        const result = SettingsDefaultsManager.loadFromFile(settingsPath);

        expect(result).toEqual(SettingsDefaultsManager.getAllDefaults());
      });

      it('should return defaults when file contains only whitespace', () => {
        writeFileSync(settingsPath, '   \n\t  ');

        const result = SettingsDefaultsManager.loadFromFile(settingsPath);

        expect(result).toEqual(SettingsDefaultsManager.getAllDefaults());
      });

      it('should return defaults when file contains null', () => {
        writeFileSync(settingsPath, 'null');

        const result = SettingsDefaultsManager.loadFromFile(settingsPath);

        expect(result).toEqual(SettingsDefaultsManager.getAllDefaults());
      });

      it('should return defaults when file contains array instead of object', () => {
        writeFileSync(settingsPath, '["array", "not", "object"]');

        const result = SettingsDefaultsManager.loadFromFile(settingsPath);

        expect(result).toEqual(SettingsDefaultsManager.getAllDefaults());
      });

      it('should return defaults when file contains primitive value', () => {
        writeFileSync(settingsPath, '"just a string"');

        const result = SettingsDefaultsManager.loadFromFile(settingsPath);

        expect(result).toEqual(SettingsDefaultsManager.getAllDefaults());
      });
    });

    describe('nested schema migration', () => {
      it('should migrate old nested { env: {...} } schema to flat schema', () => {
        const nestedSettings = {
          env: {
            CLAUDE_MEM_MODEL: 'nested-model',
            CLAUDE_MEM_WORKER_PORT: '54321',
          },
        };
        writeFileSync(settingsPath, JSON.stringify(nestedSettings));

        const result = SettingsDefaultsManager.loadFromFile(settingsPath);

        expect(result.CLAUDE_MEM_MODEL).toBe('nested-model');
      expect(result.CLAUDE_MEM_WORKER_PORT).toBe('54321');
    });

      it('should auto-migrate file from nested to flat schema', () => {
        const nestedSettings = {
          env: {
            CLAUDE_MEM_MODEL: 'migrated-model',
          },
        };
        writeFileSync(settingsPath, JSON.stringify(nestedSettings));

        SettingsDefaultsManager.loadFromFile(settingsPath);

        const content = readFileSync(settingsPath, 'utf-8');
        const parsed = JSON.parse(content);
        expect(parsed.env).toBeUndefined();
        expect(parsed.CLAUDE_MEM_MODEL).toBe('migrated-model');
      });

      it('retains the env wrapper when it has root peers, and reads settings from it', () => {
        const wrapped = {
          theme: 'dark',
          permissions: { defaultMode: 'auto' },
          env: {
            CLAUDE_MEM_MODEL: 'wrapped-model',
          },
        };
        writeFileSync(settingsPath, JSON.stringify(wrapped));

        const result = SettingsDefaultsManager.loadFromFile(settingsPath);

        expect(result.CLAUDE_MEM_MODEL).toBe('wrapped-model');
        expect(JSON.parse(readFileSync(settingsPath, 'utf-8'))).toEqual(wrapped);
      });

      it('reads root claude-mem keys when the env block beside them only holds Claude Code settings', () => {
        writeFileSync(settingsPath, JSON.stringify({
          CLAUDE_MEM_MODEL: 'root-model',
          env: { CLAUDE_CODE_PATH: '~/bin/claude' },
        }));

        expect(SettingsDefaultsManager.loadFromFile(settingsPath).CLAUDE_MEM_MODEL).toBe('root-model');
      });

      it('should not overwrite the settings file when env is an array containing ["sentinel"]', () => {
        const original = JSON.stringify({ env: ['sentinel'], CLAUDE_MEM_MODEL: 'keep-me' });
        writeFileSync(settingsPath, original);

        const result = SettingsDefaultsManager.loadFromFile(settingsPath);

        const after = readFileSync(settingsPath, 'utf-8');
        const parsed = JSON.parse(after);
        expect(Array.isArray(parsed)).toBe(false);
        expect(parsed.env).toEqual(['sentinel']);
        expect(parsed.CLAUDE_MEM_MODEL).toBe('keep-me');
        expect(result.CLAUDE_MEM_MODEL).toBe('keep-me');
      });

      it('should preserve an object-valued env setting across repeated loads', () => {
        const nestedValue = { enabled: true, sources: ['local'] };
        writeFileSync(settingsPath, JSON.stringify({
          env: {
            env: nestedValue,
            CLAUDE_MEM_MODEL: 'nested-model',
          },
        }));

        SettingsDefaultsManager.loadFromFile(settingsPath);
        expect(JSON.parse(readFileSync(settingsPath, 'utf-8')).env).toEqual(nestedValue);

        SettingsDefaultsManager.loadFromFile(settingsPath);
        expect(JSON.parse(readFileSync(settingsPath, 'utf-8')).env).toEqual(nestedValue);
      });

      it('should preserve peer root keys instead of flattening a mixed nested document', () => {
        const nestedSettings = {
          theme: 'dark',
          permissions: { defaultMode: 'auto' },
          env: {
            CLAUDE_MEM_MODEL: 'nested-model',
          },
        };
        writeFileSync(settingsPath, JSON.stringify(nestedSettings));

        const result = SettingsDefaultsManager.loadFromFile(settingsPath);

        expect(result.CLAUDE_MEM_MODEL).toBe('nested-model');
        const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
        expect(parsed.theme).toBe('dark');
        expect(parsed.permissions).toEqual({ defaultMode: 'auto' });
        expect(parsed.env.CLAUDE_MEM_MODEL).toBe('nested-model');
      });
    });

    // A fresh settings.json is seeded with every default, so installs created
    // while 'security_alert' was the default have it frozen on disk. Without
    // this migration a newly-added trigger type never reaches them.
    describe('Telegram trigger types migration', () => {
      it('should migrate the exact legacy default to the current default', () => {
        writeFileSync(settingsPath, JSON.stringify({
          CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES: 'security_alert',
        }));

        const result = SettingsDefaultsManager.loadFromFile(settingsPath);

        expect(result.CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES).toBe(
          SettingsDefaultsManager.getAllDefaults().CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES
        );
        expect(result.CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES.split(',')).toContain('sensitive');
      });

      it('should persist the migrated trigger types back to the file', () => {
        writeFileSync(settingsPath, JSON.stringify({
          CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES: 'security_alert',
          CLAUDE_MEM_TELEGRAM_CHAT_ID: '12345',
        }));

        SettingsDefaultsManager.loadFromFile(settingsPath);

        const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
        expect(parsed.CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES.split(',')).toContain('sensitive');
        // Unrelated persisted keys survive the rewrite.
        expect(parsed.CLAUDE_MEM_TELEGRAM_CHAT_ID).toBe('12345');
      });

      it('should preserve a customized trigger list', () => {
        writeFileSync(settingsPath, JSON.stringify({
          CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES: 'bugfix,decision',
        }));

        const result = SettingsDefaultsManager.loadFromFile(settingsPath);

        expect(result.CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES).toBe('bugfix,decision');
        const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
        expect(parsed.CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES).toBe('bugfix,decision');
      });

      it('should preserve a customized list that merely contains the legacy value', () => {
        writeFileSync(settingsPath, JSON.stringify({
          CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES: 'security_alert,security_note',
        }));

        const result = SettingsDefaultsManager.loadFromFile(settingsPath);

        expect(result.CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES).toBe('security_alert,security_note');
      });

      it('should leave an empty opt-out list alone', () => {
        writeFileSync(settingsPath, JSON.stringify({
          CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES: '',
        }));

        const result = SettingsDefaultsManager.loadFromFile(settingsPath);

        expect(result.CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES).toBe('');
      });

      it('should be idempotent across repeated loads', () => {
        writeFileSync(settingsPath, JSON.stringify({
          CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES: 'security_alert',
        }));

        const first = SettingsDefaultsManager.loadFromFile(settingsPath);
        const second = SettingsDefaultsManager.loadFromFile(settingsPath);

        expect(second.CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES).toBe(first.CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES);
      });
    });

    describe('legacy cloud sync hub URL migration', () => {
      it('rewrites the pinned workers.dev host to sync.cmem.ai and persists', () => {
        writeFileSync(settingsPath, JSON.stringify({
          CLAUDE_MEM_CLOUD_SYNC_HUB_URL: 'https://sync-hub.black-pond-afbb.workers.dev',
          CLAUDE_MEM_CLOUD_SYNC_TOKEN: 'tok',
        }));

        const result = SettingsDefaultsManager.loadFromFile(settingsPath);

        expect(result.CLAUDE_MEM_CLOUD_SYNC_HUB_URL).toBe('https://sync.cmem.ai');
        const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
        expect(parsed.CLAUDE_MEM_CLOUD_SYNC_HUB_URL).toBe('https://sync.cmem.ai');
        expect(parsed.CLAUDE_MEM_CLOUD_SYNC_TOKEN).toBe('tok');
      });

      it('rewrites even when the stored URL has a trailing slash or http scheme', () => {
        writeFileSync(settingsPath, JSON.stringify({
          CLAUDE_MEM_CLOUD_SYNC_HUB_URL: 'http://sync-hub.black-pond-afbb.workers.dev/',
        }));

        const result = SettingsDefaultsManager.loadFromFile(settingsPath);
        expect(result.CLAUDE_MEM_CLOUD_SYNC_HUB_URL).toBe('https://sync.cmem.ai');
      });

      it('leaves a different hub host untouched', () => {
        writeFileSync(settingsPath, JSON.stringify({
          CLAUDE_MEM_CLOUD_SYNC_HUB_URL: 'https://sync.example.test',
        }));

        const result = SettingsDefaultsManager.loadFromFile(settingsPath);
        expect(result.CLAUDE_MEM_CLOUD_SYNC_HUB_URL).toBe('https://sync.example.test');
        const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
        expect(parsed.CLAUDE_MEM_CLOUD_SYNC_HUB_URL).toBe('https://sync.example.test');
      });
    });

    // Every settings.json was seeded with xiaomi/mimo-v2-flash:free, which
    // OpenRouter has since retired: each observer call 404s and nothing is
    // remembered (#3659). Only the openrouter.ai tuple is rewritten.
    describe('retired OpenRouter default model migration', () => {
      const RETIRED = 'xiaomi/mimo-v2-flash:free';
      const CURRENT = SettingsDefaultsManager.getAllDefaults().CLAUDE_MEM_OPENROUTER_MODEL;
      const CMEM_GATEWAY = 'https://cmem.ai/api/inference/v1';

      function migrationWarnings(warnings: string[]): string[] {
        return warnings.filter((line) => line.includes('retired default'));
      }

      it('ships a default that is not itself retired', () => {
        expect(CURRENT).toBe('cohere/north-mini-code:free');
        expect(CURRENT).not.toBe(RETIRED);
      });

      // The retired id shipped in all three copies at once; a default changed in
      // one place only would leave the viewer or openclaw installs on a dead id.
      it('keeps the viewer and openclaw installer copies of the default in sync', () => {
        expect(VIEWER_DEFAULT_SETTINGS.CLAUDE_MEM_OPENROUTER_MODEL).toBe(CURRENT);

        const installer = readFileSync(new URL('../../openclaw/install.sh', import.meta.url), 'utf-8');
        const installerModels = [
          // settings defaults and the openrouter provider override
          ...installer.matchAll(/CLAUDE_MEM_OPENROUTER_MODEL(?::| =) '([^']+)'/g),
          // completion summary
          ...installer.matchAll(/provider_display="OpenRouter \(([^)]+)\)"/g),
        ].map((match) => match[1]);
        expect(installerModels).toEqual([CURRENT, CURRENT, CURRENT]);
      });

      it.each([
        ['blank', { CLAUDE_MEM_OPENROUTER_BASE_URL: '' }],
        ['missing', {}],
        ['openrouter.ai', { CLAUDE_MEM_OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1' }],
      ])('moves the retired default to the current one once when the base URL is %s', (_label, baseUrl) => {
        writeFileSync(settingsPath, JSON.stringify({
          CLAUDE_MEM_PROVIDER: 'openrouter',
          CLAUDE_MEM_OPENROUTER_API_KEY: 'sk-or-personal',
          CLAUDE_MEM_OPENROUTER_MODEL: RETIRED,
          ...baseUrl,
        }));

        const first = captureWarnings(() => SettingsDefaultsManager.loadFromFile(settingsPath));

        expect(first.value.CLAUDE_MEM_OPENROUTER_MODEL).toBe(CURRENT);
        const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
        expect(parsed.CLAUDE_MEM_OPENROUTER_MODEL).toBe(CURRENT);
        // The rest of the tuple survives the rewrite.
        expect(parsed.CLAUDE_MEM_OPENROUTER_API_KEY).toBe('sk-or-personal');
        expect(parsed.CLAUDE_MEM_PROVIDER).toBe('openrouter');
        const [logLine, ...extra] = migrationWarnings(first.warnings);
        expect(extra).toEqual([]);
        expect(logLine).toContain(`${RETIRED} to ${CURRENT}`);
        expect(logLine).toContain(settingsPath);

        const second = captureWarnings(() => SettingsDefaultsManager.loadFromFile(settingsPath));
        expect(second.value.CLAUDE_MEM_OPENROUTER_MODEL).toBe(CURRENT);
        expect(migrationWarnings(second.warnings)).toEqual([]);
      });

      it('never touches a cmem gateway tuple', () => {
        // A real gateway tuple (cmem-observer) and the retired id behind the
        // gateway URL: the base-URL gate alone must keep both unwritten.
        for (const model of ['cmem-observer', RETIRED]) {
          const raw = JSON.stringify({
            CLAUDE_MEM_PROVIDER: 'openrouter',
            CLAUDE_MEM_OPENROUTER_API_KEY: 'cm_pro_test_key_value',
            CLAUDE_MEM_OPENROUTER_BASE_URL: CMEM_GATEWAY,
            CLAUDE_MEM_OPENROUTER_MODEL: model,
          });
          writeFileSync(settingsPath, raw);

          const { value, warnings } = captureWarnings(() => SettingsDefaultsManager.loadFromFile(settingsPath, false));

          expect(value.CLAUDE_MEM_OPENROUTER_MODEL).toBe(model);
          expect(readFileSync(settingsPath, 'utf-8')).toBe(raw);
          expect(migrationWarnings(warnings)).toEqual([]);
        }
      });

      it('never rewrites the staged CLAUDE_MEM_PRO_MEMORY_MODEL', () => {
        writeFileSync(settingsPath, JSON.stringify({
          CLAUDE_MEM_OPENROUTER_MODEL: RETIRED,
          CLAUDE_MEM_OPENROUTER_BASE_URL: '',
          CLAUDE_MEM_PRO_MEMORY_KEY: 'cm_pro_staged_key_value',
          CLAUDE_MEM_PRO_MEMORY_BASE_URL: CMEM_GATEWAY,
          CLAUDE_MEM_PRO_MEMORY_MODEL: RETIRED,
        }));

        const result = SettingsDefaultsManager.loadFromFile(settingsPath, false);

        expect(result.CLAUDE_MEM_OPENROUTER_MODEL).toBe(CURRENT);
        expect(result.CLAUDE_MEM_PRO_MEMORY_MODEL).toBe(RETIRED);
        const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
        expect(parsed.CLAUDE_MEM_PRO_MEMORY_MODEL).toBe(RETIRED);
        expect(parsed.CLAUDE_MEM_PRO_MEMORY_BASE_URL).toBe(CMEM_GATEWAY);
      });

      it.each([
        'https://api.deepseek.com',
        'http://localhost:1234/v1',
        'https://openrouter.ai.evil.example/v1',
        'https://gateway.example.com/proxy/openrouter.ai/v1',
      ])('leaves the model alone on the custom endpoint %s', (baseUrl) => {
        const raw = JSON.stringify({
          CLAUDE_MEM_OPENROUTER_BASE_URL: baseUrl,
          CLAUDE_MEM_OPENROUTER_MODEL: RETIRED,
        });
        writeFileSync(settingsPath, raw);

        const result = SettingsDefaultsManager.loadFromFile(settingsPath, false);

        expect(result.CLAUDE_MEM_OPENROUTER_MODEL).toBe(RETIRED);
        expect(readFileSync(settingsPath, 'utf-8')).toBe(raw);
      });

      it.each([
        ['a different model', 'anthropic/claude-haiku-4.5'],
        ['a fallback list led by the retired id', [RETIRED, 'vendor/backup-model:free']],
        ['a comma list led by the retired id', `${RETIRED},vendor/backup-model:free`],
      ])('leaves %s chosen by the user untouched', (_label, model) => {
        const raw = JSON.stringify({
          CLAUDE_MEM_OPENROUTER_BASE_URL: '',
          CLAUDE_MEM_OPENROUTER_MODEL: model,
        });
        writeFileSync(settingsPath, raw);

        const result = SettingsDefaultsManager.loadFromFile(settingsPath, false);

        expect(result.CLAUDE_MEM_OPENROUTER_MODEL).toEqual(model as string);
        expect(readFileSync(settingsPath, 'utf-8')).toBe(raw);
      });

      it('keeps the peer root keys of a nested settings file', () => {
        writeFileSync(settingsPath, JSON.stringify({
          env: { CLAUDE_MEM_OPENROUTER_MODEL: RETIRED },
          hooks: { SessionStart: [] },
        }));

        const result = SettingsDefaultsManager.loadFromFile(settingsPath, false);

        expect(result.CLAUDE_MEM_OPENROUTER_MODEL).toBe(CURRENT);
        const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
        expect(parsed.env.CLAUDE_MEM_OPENROUTER_MODEL).toBe(CURRENT);
        expect(parsed.hooks).toEqual({ SessionStart: [] });
      });
    });

    // Two per-request deadlines were raised from the same seeded 30000: the
    // observer request (#4278) and the oversized-field condensation pass, both
    // sent to the same backend. Every settings.json seeded while 30000 was the
    // default holds it on disk, and a persisted value wins over DEFAULTS, so a
    // raised default would never reach those installs. The cmem.ai gateway's
    // normal tail runs past 30s, and an abandoned request can still be billed
    // upstream.
    describe.each([
      ['CLAUDE_MEM_LLM_TIMEOUT_MS'],
      ['CLAUDE_MEM_FIELD_OPTIMIZE_TIMEOUT_MS'],
    ] as const)('raised deadline default migration: %s', (KEY) => {
      const LEGACY = '30000';
      const CURRENT = SettingsDefaultsManager.getAllDefaults()[KEY];

      function migrationWarnings(warnings: string[]): string[] {
        return warnings.filter((line) => line.includes(KEY));
      }

      it('ships the raised 180s default', () => {
        expect(CURRENT).toBe('180000');
      });

      it('moves the seeded 30000 to the current default once, with one log line', () => {
        writeFileSync(settingsPath, JSON.stringify({
          CLAUDE_MEM_PROVIDER: 'openrouter',
          [KEY]: LEGACY,
        }));

        const first = captureWarnings(() => SettingsDefaultsManager.loadFromFile(settingsPath, false));

        expect(first.value[KEY]).toBe(CURRENT);
        const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
        expect(parsed[KEY]).toBe(CURRENT);
        // The rest of the file survives the rewrite.
        expect(parsed.CLAUDE_MEM_PROVIDER).toBe('openrouter');
        const [logLine, ...extra] = migrationWarnings(first.warnings);
        expect(extra).toEqual([]);
        expect(logLine).toContain(`30000ms default to ${CURRENT}ms`);
        expect(logLine).toContain(settingsPath);

        const second = captureWarnings(() => SettingsDefaultsManager.loadFromFile(settingsPath, false));
        expect(second.value[KEY]).toBe(CURRENT);
        expect(migrationWarnings(second.warnings)).toEqual([]);
      });

      it.each([
        ['a raised deadline', '120000'],
        ['a lowered deadline', '15000'],
        ['a deadline written as a JSON number', 90000],
        // Every writer persists the string; a bare number is a hand edit.
        ['the legacy value hand-written as a JSON number', 30000],
      ])('leaves %s chosen by the user untouched', (_label, value) => {
        const raw = JSON.stringify({ [KEY]: value });
        writeFileSync(settingsPath, raw);

        const { value: result, warnings } = captureWarnings(
          () => SettingsDefaultsManager.loadFromFile(settingsPath, false),
        );

        expect(result[KEY]).toEqual(value as string);
        expect(readFileSync(settingsPath, 'utf-8')).toBe(raw);
        expect(migrationWarnings(warnings)).toEqual([]);
      });

      // Like every other settings.json writer since #3498: the file holds API
      // keys and sync tokens, so the rewrite leaves it owner-only even when an
      // older build had left it readable.
      it('rewrites the file owner-only', () => {
        if (process.platform === 'win32') return;
        writeFileSync(settingsPath, JSON.stringify({ [KEY]: LEGACY }));
        chmodSync(settingsPath, 0o644);

        SettingsDefaultsManager.loadFromFile(settingsPath, false);

        expect(JSON.parse(readFileSync(settingsPath, 'utf-8'))[KEY]).toBe(CURRENT);
        expect(statSync(settingsPath).mode & 0o777).toBe(0o600);
      });

      it('keeps the peer root keys of a nested settings file', () => {
        writeFileSync(settingsPath, JSON.stringify({
          env: { [KEY]: LEGACY },
          hooks: { SessionStart: [] },
        }));

        const result = SettingsDefaultsManager.loadFromFile(settingsPath, false);

        expect(result[KEY]).toBe(CURRENT);
        const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
        expect(parsed.env[KEY]).toBe(CURRENT);
        expect(parsed.hooks).toEqual({ SessionStart: [] });
      });

      // The move runs once per settings file. Without a marker it ran on every
      // load, so a 30000 the user chose later was silently moved back to the
      // new default.
      it.each([
        ['after the seeded value was moved', JSON.stringify({ [KEY]: LEGACY })],
        ['on an install that never held the old default', JSON.stringify({ [KEY]: '120000' })],
        ['on a settings file created fresh', null],
      ])('keeps a 30000 the user sets %s', (_label, initial) => {
        if (initial !== null) writeFileSync(settingsPath, initial);
        SettingsDefaultsManager.loadFromFile(settingsPath, false);

        writeFileSync(settingsPath, JSON.stringify({ [KEY]: LEGACY }));
        const { value, warnings } = captureWarnings(() => SettingsDefaultsManager.loadFromFile(settingsPath, false));

        expect(value[KEY]).toBe(LEGACY);
        expect(JSON.parse(readFileSync(settingsPath, 'utf-8'))[KEY]).toBe(LEGACY);
        expect(migrationWarnings(warnings)).toEqual([]);
      });

      // settings.json can be a symlink into a read-only store (Nix home-manager).
      // The move still applies in memory, but saving it fails on every load, and
      // every observer request loads settings (retry.ts), so it is said once.
      it('warns once per process when the move cannot be saved, and still uses the new default', () => {
        if (process.platform === 'win32' || process.getuid?.() === 0) return;
        const storeDir = join(tempDir, 'read-only-store');
        mkdirSync(storeDir);
        const storedSettings = join(storeDir, 'settings.json');
        const raw = JSON.stringify({ [KEY]: LEGACY });
        writeFileSync(storedSettings, raw);
        symlinkSync(storedSettings, settingsPath);
        chmodSync(storeDir, 0o555);
        try {
          const loads = [1, 2, 3].map(() => captureWarnings(() => SettingsDefaultsManager.loadFromFile(settingsPath, false)));

          for (const { value } of loads) expect(value[KEY]).toBe(CURRENT);
          const failures = loads.flatMap(({ warnings }) => migrationWarnings(warnings));
          expect(failures).toHaveLength(1);
          expect(failures[0]).toContain('Failed to migrate');
          expect(readFileSync(storedSettings, 'utf-8')).toBe(raw);
        } finally {
          chmodSync(storeDir, 0o755);
        }
      });
    });

    // The seeders wrote both deadlines side by side, so one load moves both,
    // each with its own log line, and leaves the rest of the file alone.
    it('moves both seeded deadlines in one load', () => {
      writeFileSync(settingsPath, JSON.stringify({
        CLAUDE_MEM_PROVIDER: 'openrouter',
        CLAUDE_MEM_LLM_TIMEOUT_MS: '30000',
        CLAUDE_MEM_FIELD_OPTIMIZE_TIMEOUT_MS: '30000',
      }));

      const { value, warnings } = captureWarnings(() => SettingsDefaultsManager.loadFromFile(settingsPath, false));

      expect(value.CLAUDE_MEM_LLM_TIMEOUT_MS).toBe('180000');
      expect(value.CLAUDE_MEM_FIELD_OPTIMIZE_TIMEOUT_MS).toBe('180000');
      const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(parsed).toEqual({
        CLAUDE_MEM_PROVIDER: 'openrouter',
        CLAUDE_MEM_LLM_TIMEOUT_MS: '180000',
        CLAUDE_MEM_FIELD_OPTIMIZE_TIMEOUT_MS: '180000',
      });
      expect(warnings.filter((line) => line.includes('Migrated CLAUDE_MEM_'))).toHaveLength(2);
    });

    // loadFromFile only carries keys declared in DEFAULTS, so before the Pro
    // sign-in keys were declared, an installer-written settings.json lost
    // them on every load (the round-trip-loss gap fixed by the install-first
    // login flow plan, Phase 4).
    describe('CMEM Pro sign-in keys round-trip', () => {
      const proKeys = {
        CLAUDE_MEM_PRO_TRIAL_EMAIL: 'dev@example.com',
        CLAUDE_MEM_PRO_TRIAL_AT: '2026-08-26T12:00:00.000Z',
        CLAUDE_MEM_PRO_TRIAL_STATE: 'active',
        CLAUDE_MEM_PRO_TRIAL_ENDS_AT: '2026-09-02T12:00:00.000Z',
        CLAUDE_MEM_PRO_PLAN: 'trial',
        CLAUDE_MEM_PRO_MEMORY_KEY: 'cm_pro_staged_test_key',
        CLAUDE_MEM_PRO_MEMORY_BASE_URL: 'https://cmem.ai/api/inference/v1',
        CLAUDE_MEM_PRO_MEMORY_MODEL: 'cmem-observer',
      };

      it('should surface all Pro account and staged-memory keys from settings.json', () => {
        writeFileSync(settingsPath, JSON.stringify(proKeys));

        const result = SettingsDefaultsManager.loadFromFile(settingsPath);

        expect(result.CLAUDE_MEM_PRO_TRIAL_EMAIL).toBe('dev@example.com');
        expect(result.CLAUDE_MEM_PRO_TRIAL_AT).toBe('2026-08-26T12:00:00.000Z');
        expect(result.CLAUDE_MEM_PRO_TRIAL_STATE).toBe('active');
        expect(result.CLAUDE_MEM_PRO_TRIAL_ENDS_AT).toBe('2026-09-02T12:00:00.000Z');
        expect(result.CLAUDE_MEM_PRO_PLAN).toBe('trial');
        expect(result.CLAUDE_MEM_PRO_MEMORY_KEY).toBe('cm_pro_staged_test_key');
        expect(result.CLAUDE_MEM_PRO_MEMORY_BASE_URL).toBe('https://cmem.ai/api/inference/v1');
        expect(result.CLAUDE_MEM_PRO_MEMORY_MODEL).toBe('cmem-observer');
      });

      it('should default all Pro account and staged-memory keys to empty strings', () => {
        const defaults = SettingsDefaultsManager.getAllDefaults();

        expect(defaults.CLAUDE_MEM_PRO_TRIAL_EMAIL).toBe('');
        expect(defaults.CLAUDE_MEM_PRO_TRIAL_AT).toBe('');
        expect(defaults.CLAUDE_MEM_PRO_TRIAL_STATE).toBe('');
        expect(defaults.CLAUDE_MEM_PRO_TRIAL_ENDS_AT).toBe('');
        expect(defaults.CLAUDE_MEM_PRO_PLAN).toBe('');
        expect(defaults.CLAUDE_MEM_PRO_MEMORY_KEY).toBe('');
        expect(defaults.CLAUDE_MEM_PRO_MEMORY_BASE_URL).toBe('');
        expect(defaults.CLAUDE_MEM_PRO_MEMORY_MODEL).toBe('');
      });

      it('should keep the Pro keys on disk when loading rewrites the file (nested-schema migration)', () => {
        writeFileSync(settingsPath, JSON.stringify({ env: proKeys }));

        const result = SettingsDefaultsManager.loadFromFile(settingsPath);

        expect(result.CLAUDE_MEM_PRO_TRIAL_STATE).toBe('active');
        const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
        expect(parsed.CLAUDE_MEM_PRO_TRIAL_EMAIL).toBe('dev@example.com');
        expect(parsed.CLAUDE_MEM_PRO_PLAN).toBe('trial');
        expect(parsed.CLAUDE_MEM_PRO_MEMORY_KEY).toBe('cm_pro_staged_test_key');
      });
    });

    describe('edge cases', () => {
      it('should handle empty object in file', () => {
        writeFileSync(settingsPath, '{}');

        const result = SettingsDefaultsManager.loadFromFile(settingsPath);

        expect(result).toEqual(SettingsDefaultsManager.getAllDefaults());
      });

      it('should ignore unknown keys in file', () => {
        const settingsWithUnknown = {
          CLAUDE_MEM_MODEL: 'known-model',
          UNKNOWN_KEY: 'should-be-ignored',
          ANOTHER_UNKNOWN: 12345,
        };
        writeFileSync(settingsPath, JSON.stringify(settingsWithUnknown));

        const result = SettingsDefaultsManager.loadFromFile(settingsPath);

        expect(result.CLAUDE_MEM_MODEL).toBe('known-model');
        expect((result as Record<string, unknown>).UNKNOWN_KEY).toBeUndefined();
      });

      it('should handle file with BOM', () => {
        const bom = '\uFEFF';
        const settings = { CLAUDE_MEM_MODEL: 'bom-model' };
        writeFileSync(settingsPath, bom + JSON.stringify(settings));

        const result = SettingsDefaultsManager.loadFromFile(settingsPath);

        expect(result).toBeDefined();
      });

      it('should read BOM-prefixed flat settings through install helpers', () => {
        writeFileSync(settingsPath, '\uFEFF' + JSON.stringify({
          env: {
            CLAUDE_MEM_PROVIDER: 'gemini',
          },
        }));

        const result = readFlatSettings(settingsPath);

        expect(result?.CLAUDE_MEM_PROVIDER).toBe('gemini');
      });

      it('should create defaults without leaving atomic temp files behind', () => {
        expect(existsSync(settingsPath)).toBe(false);

        SettingsDefaultsManager.loadFromFile(settingsPath);

        expect(existsSync(settingsPath)).toBe(true);
        expect(readdirSync(tempDir).filter(name => name.endsWith('.tmp'))).toEqual([]);
      });
    });
  });

  describe('stdout discipline', () => {
    // CLI commands like `start` promise machine-readable JSON on stdout to
    // the hook framework; settings bootstrap runs inside them, so its
    // informational notices must go to stderr. PR #2894 CI caught the
    // creation notice corrupting the start command's JSON on first boot in
    // a fresh data dir.
    it('should not write to stdout when creating the settings file', () => {
      const stdoutCalls: unknown[][] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]) => { stdoutCalls.push(args); };
      try {
        expect(existsSync(settingsPath)).toBe(false);
        SettingsDefaultsManager.loadFromFile(settingsPath);
        expect(existsSync(settingsPath)).toBe(true);
        expect(stdoutCalls).toEqual([]);
      } finally {
        console.log = originalLog;
      }
    });

    it('should not write to stdout when migrating a nested-schema file', () => {
      writeFileSync(settingsPath, JSON.stringify({ env: { CLAUDE_MEM_MODEL: 'nested-model' } }));
      const stdoutCalls: unknown[][] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]) => { stdoutCalls.push(args); };
      try {
        SettingsDefaultsManager.loadFromFile(settingsPath);
        expect(stdoutCalls).toEqual([]);
      } finally {
        console.log = originalLog;
      }
    });
  });

  describe('getAllDefaults', () => {
    it('should return a copy of defaults', () => {
      const defaults1 = SettingsDefaultsManager.getAllDefaults();
      const defaults2 = SettingsDefaultsManager.getAllDefaults();

      expect(defaults1).toEqual(defaults2);
      expect(defaults1).not.toBe(defaults2); 
    });

    it('should include all expected keys', () => {
      const defaults = SettingsDefaultsManager.getAllDefaults();

      expect(defaults.CLAUDE_MEM_MODEL).toBeDefined();
      expect(defaults.CLAUDE_MEM_WORKER_PORT).toBeDefined();
      expect(defaults.CLAUDE_MEM_WORKER_HOST).toBeDefined();

      expect(defaults.CLAUDE_MEM_PROVIDER).toBeDefined();
      expect(defaults.CLAUDE_MEM_GEMINI_API_KEY).toBeDefined();
      expect(defaults.CLAUDE_MEM_OPENROUTER_API_KEY).toBeDefined();

      expect(defaults.CLAUDE_MEM_DATA_DIR).toBeDefined();
      expect(defaults.CLAUDE_MEM_LOG_LEVEL).toBeDefined();
      expect(defaults.CLAUDE_MEM_GROK_BOT_WEBHOOK_URL).toBeDefined();
      expect(defaults.CLAUDE_MEM_GROK_BOT_WEBHOOK_SECRET).toBeDefined();
    });

    // #2753 — new key: empty by default (fall through to
    // process.env.CLAUDE_CONFIG_DIR/default in oauth-token.ts's
    // resolveEffectiveClaudeConfigDir), overridable via file or env like any
    // other setting (the generic per-key loops in loadFromFile/
    // applyEnvOverrides need no key-specific code).
    it('CLAUDE_MEM_CLAUDE_CONFIG_DIR defaults to empty string', () => {
      expect(SettingsDefaultsManager.getAllDefaults().CLAUDE_MEM_CLAUDE_CONFIG_DIR).toBe('');
    });

    it('cloud sync content flush knobs default to 40 ops / 90s', () => {
      const defaults = SettingsDefaultsManager.getAllDefaults();
      expect(defaults.CLAUDE_MEM_CLOUD_SYNC_CONTENT_BATCH_SIZE).toBe('40');
      expect(defaults.CLAUDE_MEM_CLOUD_SYNC_REQUEST_TIMEOUT_MS).toBe('90000');
    });
  });

  describe('get', () => {
    it('should return default value for key', () => {
      expect(SettingsDefaultsManager.get('CLAUDE_MEM_MODEL')).toBe('claude-haiku-4-5-20251001');
      const expectedPort = String(37700 + ((process.getuid?.() ?? 77) % 100));
      expect(SettingsDefaultsManager.get('CLAUDE_MEM_WORKER_PORT')).toBe(expectedPort);
    });
  });

  describe('getInt', () => {
    it('should return integer value for numeric string', () => {
      const expectedPort = 37700 + ((process.getuid?.() ?? 77) % 100);
      expect(SettingsDefaultsManager.getInt('CLAUDE_MEM_WORKER_PORT')).toBe(expectedPort);
      expect(SettingsDefaultsManager.getInt('CLAUDE_MEM_CONTEXT_OBSERVATIONS')).toBe(50);
    });
  });

  describe('environment variable overrides', () => {
    const originalEnv: Record<string, string | undefined> = {};

    beforeEach(() => {
      originalEnv.CLAUDE_MEM_WORKER_PORT = process.env.CLAUDE_MEM_WORKER_PORT;
      originalEnv.CLAUDE_MEM_MODEL = process.env.CLAUDE_MEM_MODEL;
      originalEnv.CLAUDE_MEM_LOG_LEVEL = process.env.CLAUDE_MEM_LOG_LEVEL;
    });

    afterEach(() => {
      if (originalEnv.CLAUDE_MEM_WORKER_PORT === undefined) {
        delete process.env.CLAUDE_MEM_WORKER_PORT;
      } else {
        process.env.CLAUDE_MEM_WORKER_PORT = originalEnv.CLAUDE_MEM_WORKER_PORT;
      }
      if (originalEnv.CLAUDE_MEM_MODEL === undefined) {
        delete process.env.CLAUDE_MEM_MODEL;
      } else {
        process.env.CLAUDE_MEM_MODEL = originalEnv.CLAUDE_MEM_MODEL;
      }
      if (originalEnv.CLAUDE_MEM_LOG_LEVEL === undefined) {
        delete process.env.CLAUDE_MEM_LOG_LEVEL;
      } else {
        process.env.CLAUDE_MEM_LOG_LEVEL = originalEnv.CLAUDE_MEM_LOG_LEVEL;
      }
    });

    it('should prioritize env var over file setting', () => {
      const fileSettings = {
        CLAUDE_MEM_WORKER_PORT: '12345',
      };
      writeFileSync(settingsPath, JSON.stringify(fileSettings));
      process.env.CLAUDE_MEM_WORKER_PORT = '54321';

      const result = SettingsDefaultsManager.loadFromFile(settingsPath);

        expect(result.CLAUDE_MEM_WORKER_PORT).toBe('54321');
      });

    it('keeps a wrapped document with a root peer intact, including a nested setting named env', () => {
      const wrapped = {
        theme: 'dark',
        env: { env: 'keep-me', CLAUDE_MEM_MODEL: 'nested-model' },
      };
      writeFileSync(settingsPath, JSON.stringify(wrapped));

      const result = SettingsDefaultsManager.loadFromFile(settingsPath);

      expect(result.CLAUDE_MEM_MODEL).toBe('nested-model');
      expect(JSON.parse(readFileSync(settingsPath, 'utf-8'))).toEqual(wrapped);
    });

    it('should prioritize env var over default', () => {
      process.env.CLAUDE_MEM_WORKER_PORT = '99999';

      const result = SettingsDefaultsManager.loadFromFile(settingsPath);

      expect(result.CLAUDE_MEM_WORKER_PORT).toBe('99999');
    });

    // #2753 — CLAUDE_MEM_CLAUDE_CONFIG_DIR is overridable via the file and
    // via CLAUDE_MEM_CLAUDE_CONFIG_DIR env, same as any other key (no
    // key-specific code was added — the generic loops already handle it).
    it('CLAUDE_MEM_CLAUDE_CONFIG_DIR: file value is honored, and env overrides the file', () => {
      const originalConfigDirEnv = process.env.CLAUDE_MEM_CLAUDE_CONFIG_DIR;
      try {
        delete process.env.CLAUDE_MEM_CLAUDE_CONFIG_DIR;
        writeFileSync(settingsPath, JSON.stringify({ CLAUDE_MEM_CLAUDE_CONFIG_DIR: '/from/file' }));

        expect(SettingsDefaultsManager.loadFromFile(settingsPath).CLAUDE_MEM_CLAUDE_CONFIG_DIR).toBe('/from/file');

        process.env.CLAUDE_MEM_CLAUDE_CONFIG_DIR = '/from/env';
        expect(SettingsDefaultsManager.loadFromFile(settingsPath).CLAUDE_MEM_CLAUDE_CONFIG_DIR).toBe('/from/env');
      } finally {
        if (originalConfigDirEnv === undefined) {
          delete process.env.CLAUDE_MEM_CLAUDE_CONFIG_DIR;
        } else {
          process.env.CLAUDE_MEM_CLAUDE_CONFIG_DIR = originalConfigDirEnv;
        }
      }
    });

    it('should use file setting when env var is not set', () => {
      const fileSettings = {
        CLAUDE_MEM_WORKER_PORT: '11111',
      };
      writeFileSync(settingsPath, JSON.stringify(fileSettings));
      delete process.env.CLAUDE_MEM_WORKER_PORT;

      const result = SettingsDefaultsManager.loadFromFile(settingsPath);

      expect(result.CLAUDE_MEM_WORKER_PORT).toBe('11111');
    });

    it('should apply env var override even on file parse error', () => {
      writeFileSync(settingsPath, 'invalid json {{{');
      process.env.CLAUDE_MEM_WORKER_PORT = '88888';

      const result = SettingsDefaultsManager.loadFromFile(settingsPath);

      expect(result.CLAUDE_MEM_WORKER_PORT).toBe('88888');
    });

    it('should apply multiple env var overrides', () => {
      const fileSettings = {
        CLAUDE_MEM_WORKER_PORT: '12345',
        CLAUDE_MEM_MODEL: 'file-model',
        CLAUDE_MEM_LOG_LEVEL: 'DEBUG',
      };
      writeFileSync(settingsPath, JSON.stringify(fileSettings));

      process.env.CLAUDE_MEM_WORKER_PORT = '54321';
      process.env.CLAUDE_MEM_MODEL = 'env-model';

      const result = SettingsDefaultsManager.loadFromFile(settingsPath);

      expect(result.CLAUDE_MEM_WORKER_PORT).toBe('54321');
      expect(result.CLAUDE_MEM_MODEL).toBe('env-model');
      expect(result.CLAUDE_MEM_LOG_LEVEL).toBe('DEBUG'); 
    });

    it('should document priority: env > file > defaults', () => {
      const defaults = SettingsDefaultsManager.getAllDefaults();

      const fileSettings = {
        CLAUDE_MEM_WORKER_PORT: '22222', // Different from default 37777
      };
      writeFileSync(settingsPath, JSON.stringify(fileSettings));

      process.env.CLAUDE_MEM_WORKER_PORT = '33333';

      const result = SettingsDefaultsManager.loadFromFile(settingsPath);

      const expectedDefault = String(37700 + ((process.getuid?.() ?? 77) % 100));
      expect(defaults.CLAUDE_MEM_WORKER_PORT).toBe(expectedDefault); 
      expect(result.CLAUDE_MEM_WORKER_PORT).toBe('33333'); 
    });
  });

  describe('CLAUDE_MEM_WORKER_HOST localhost normalization (#2992)', () => {
    // On modern Windows resolvers 'localhost' resolves IPv6-first while
    // server.listen(port, 'localhost') binds ::1 only, so a 'localhost'
    // host value can put the hook client and the worker on different
    // loopback families. The manager pins it to the IPv4 loopback.
    let originalHostEnv: string | undefined;

    beforeEach(() => {
      originalHostEnv = process.env.CLAUDE_MEM_WORKER_HOST;
      delete process.env.CLAUDE_MEM_WORKER_HOST;
    });

    afterEach(() => {
      if (originalHostEnv === undefined) {
        delete process.env.CLAUDE_MEM_WORKER_HOST;
      } else {
        process.env.CLAUDE_MEM_WORKER_HOST = originalHostEnv;
      }
    });

    it('should normalize a file value of localhost to 127.0.0.1', () => {
      writeFileSync(settingsPath, JSON.stringify({ CLAUDE_MEM_WORKER_HOST: 'localhost' }));

      const result = SettingsDefaultsManager.loadFromFile(settingsPath);

      expect(result.CLAUDE_MEM_WORKER_HOST).toBe('127.0.0.1');
    });

    it('should normalize an env override of localhost to 127.0.0.1', () => {
      process.env.CLAUDE_MEM_WORKER_HOST = 'localhost';

      const result = SettingsDefaultsManager.loadFromFile(settingsPath);

      expect(result.CLAUDE_MEM_WORKER_HOST).toBe('127.0.0.1');
    });

    it('should normalize localhost through get() when set via env', () => {
      process.env.CLAUDE_MEM_WORKER_HOST = 'localhost';

      expect(SettingsDefaultsManager.get('CLAUDE_MEM_WORKER_HOST')).toBe('127.0.0.1');
    });

    it('should normalize when env overrides are skipped', () => {
      writeFileSync(settingsPath, JSON.stringify({ CLAUDE_MEM_WORKER_HOST: 'localhost' }));

      const result = SettingsDefaultsManager.loadFromFile(settingsPath, false);

      expect(result.CLAUDE_MEM_WORKER_HOST).toBe('127.0.0.1');
    });

    it('should pass through non-localhost hosts unchanged', () => {
      writeFileSync(settingsPath, JSON.stringify({ CLAUDE_MEM_WORKER_HOST: '0.0.0.0' }));

      const result = SettingsDefaultsManager.loadFromFile(settingsPath);

      expect(result.CLAUDE_MEM_WORKER_HOST).toBe('0.0.0.0');
    });

    it('should not rewrite the settings file when normalizing', () => {
      const content = JSON.stringify({ CLAUDE_MEM_WORKER_HOST: 'localhost' }, null, 2);
      writeFileSync(settingsPath, content);

      SettingsDefaultsManager.loadFromFile(settingsPath);

      expect(readFileSync(settingsPath, 'utf-8')).toBe(content);
    });
  });
});

describe('Chroma embedding function default', () => {
  it('keeps chroma-mcp\'s own default so existing installs are unchanged', () => {
    expect(SettingsDefaultsManager.getAllDefaults().CLAUDE_MEM_CHROMA_EMBEDDING_FUNCTION).toBe('default');
  });
});
