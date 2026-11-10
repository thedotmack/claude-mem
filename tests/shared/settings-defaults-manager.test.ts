
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync, chmodSync, symlinkSync } from 'fs';
import { dirname, join } from 'path';
import { homedir, tmpdir } from 'os';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { getDefaultServerPort, getDefaultWorkerPort } from '../../src/shared/install-port.js';
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

function defaultsForSettingsPath(dataDir: string) {
  const defaults = SettingsDefaultsManager.getAllDefaults();
  const workerPort = String(getDefaultWorkerPort(dataDir));
  const serverPort = process.env.CLAUDE_MEM_SERVER_PORT ?? String(getDefaultServerPort(dataDir));
  defaults.CLAUDE_MEM_WORKER_PORT = workerPort;
  defaults.CLAUDE_MEM_QUEUE_REDIS_PREFIX = `claude_mem_${process.env.CLAUDE_MEM_WORKER_PORT ?? workerPort}`;
  defaults.CLAUDE_MEM_SERVER_URL = `http://127.0.0.1:${serverPort}`;
  defaults.CLAUDE_MEM_SERVER_BETA_URL = `http://127.0.0.1:${serverPort}`;
  return defaults;
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

  it('ships the Grok Bot awareness push off with no agent IDs until explicitly configured', () => {
    const defaults = {
      CLAUDE_MEM_GROK_BOT_AWARENESS_ENABLED: 'false',
      CLAUDE_MEM_GROK_BOT_AWARENESS_AGENT_IDS: '',
    };
    expect(SettingsDefaultsManager.getAllDefaults()).toMatchObject(defaults);
    expect(SettingsDefaultsManager.loadFromFile(settingsPath)).toMatchObject(defaults);
  });

  describe('loadFromFile', () => {
    describe('file does not exist', () => {
      it('should create file with defaults when file does not exist', () => {
        expect(existsSync(settingsPath)).toBe(false);

        const result = SettingsDefaultsManager.loadFromFile(settingsPath);

        expect(existsSync(settingsPath)).toBe(true);
        expect(result).toEqual(JSON.parse(readFileSync(settingsPath, 'utf-8')));
        expect(result.CLAUDE_MEM_WORKER_PORT).toBe(String(getDefaultWorkerPort(tempDir)));
      });

      it('should create the settings file as owner-readable only', () => {
        if (process.platform === 'win32') return;
        SettingsDefaultsManager.loadFromFile(settingsPath);
        expect(statSync(settingsPath).mode & 0o777).toBe(0o600);
      });
    });

    describe('directory does not exist', () => {
      it('should create directory and file when parent directory does not exist', () => {
        const nestedPath = join(tempDir, 'nested', 'deep', 'settings.json');
        expect(existsSync(join(tempDir, 'nested'))).toBe(false);

        const result = SettingsDefaultsManager.loadFromFile(nestedPath);

        expect(existsSync(join(tempDir, 'nested', 'deep'))).toBe(true);
        expect(existsSync(nestedPath)).toBe(true);
        expect(result.CLAUDE_MEM_WORKER_PORT).toBe(String(getDefaultWorkerPort(join(tempDir, 'nested', 'deep'))));
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
        expect(result.CLAUDE_MEM_WORKER_PORT).toBe(String(getDefaultWorkerPort(tempDir)));
        expect(result.CLAUDE_MEM_WORKER_HOST).toBe(defaults.CLAUDE_MEM_WORKER_HOST);
        expect(result.CLAUDE_MEM_LOG_LEVEL).toBe(defaults.CLAUDE_MEM_LOG_LEVEL);
      });

      it('should not modify existing file when loading', () => {
        const customSettings = {
          CLAUDE_MEM_MODEL: 'do-not-change',
          CLAUDE_MEM_WORKER_PORT: '41234',
          CUSTOM_KEY: 'should-persist', // Extra key not in defaults
        };
        writeFileSync(settingsPath, JSON.stringify(customSettings, null, 2));
        const originalContent = readFileSync(settingsPath, 'utf-8');

        SettingsDefaultsManager.loadFromFile(settingsPath);

        const afterContent = readFileSync(settingsPath, 'utf-8');
        expect(afterContent).toBe(originalContent);
      });

      // The context-header savings line and its two settings were removed (#5654).
      // A settings.json saved before that still carries them and must load as before.
      it('loads a settings file that still has the retired savings keys', () => {
        const content = JSON.stringify({
          CLAUDE_MEM_MODEL: 'kept-model',
          CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS: 'true',
          CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT: 'true',
          CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT: 'false',
        });
        writeFileSync(settingsPath, content);

        const { value: result, warnings } = captureWarnings(() => SettingsDefaultsManager.loadFromFile(settingsPath));

        expect(warnings).toEqual([]);
        expect(result.CLAUDE_MEM_MODEL).toBe('kept-model');
        expect(result.CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS).toBe('true');
        expect(result).not.toHaveProperty('CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT');
        expect(result).not.toHaveProperty('CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT');
        expect(readFileSync(settingsPath, 'utf-8')).toBe(content);
      });

      // Every key is declared `string` and the gates compare against a string
      // ('false'), so a hand-written JSON boolean in settings.json has to
      // arrive as that same text (#4630).
      describe('JSON primitives in settings.json', () => {
        it('should read an unquoted boolean false as "false"', () => {
          writeFileSync(settingsPath, JSON.stringify({ CLAUDE_MEM_CHROMA_ENABLED: false }));

          const result = SettingsDefaultsManager.loadFromFile(settingsPath);

          expect(result.CLAUDE_MEM_CHROMA_ENABLED).toBe('false');
        });

        it('should leave the file untouched so the user keeps their own spelling', () => {
          writeFileSync(settingsPath, JSON.stringify({ CLAUDE_MEM_CHROMA_ENABLED: false }, null, 2));
          const originalContent = readFileSync(settingsPath, 'utf-8');

          SettingsDefaultsManager.loadFromFile(settingsPath);

          expect(readFileSync(settingsPath, 'utf-8')).toBe(originalContent);
        });

        it('should leave a JSON number alone, as the deadline migrations expect', () => {
          writeFileSync(settingsPath, JSON.stringify({ CLAUDE_MEM_LLM_TIMEOUT_MS: 90000 }));

          const result = SettingsDefaultsManager.loadFromFile(settingsPath);

          expect(result.CLAUDE_MEM_LLM_TIMEOUT_MS).toEqual(90000);
        });

        it('should coerce a boolean nested under the legacy env wrapper', () => {
          writeFileSync(settingsPath, JSON.stringify({ env: { CLAUDE_MEM_CHROMA_ENABLED: false } }));

          const result = SettingsDefaultsManager.loadFromFile(settingsPath);

          expect(result.CLAUDE_MEM_CHROMA_ENABLED).toBe('false');
        });
      });
    });

    describe('file exists but is empty or corrupt', () => {
      it.each([
        ['empty', ''],
        ['invalid JSON', 'not valid json {{{{'],
        ['whitespace', '   \n\t  '],
        ['null', 'null'],
        ['array', '["array", "not", "object"]'],
        ['primitive', '"just a string"'],
      ])('returns defaults without changing %s file bytes', (_label, contents) => {
        writeFileSync(settingsPath, contents);

        const result = SettingsDefaultsManager.loadFromFile(settingsPath);

        expect(result).toEqual(defaultsForSettingsPath(tempDir));
        expect(readFileSync(settingsPath, 'utf-8')).toBe(contents);
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

      // The old viewer wrote claude-mem's keys at the ROOT of a wrapped document,
      // secrets as `****` masks. Reading those copies turned sync off (empty
      // CLOUD_SYNC_*) and handed providers a masked key.
      it('reads the real env values when an old viewer left masked root copies beside a wrapped document', () => {
        const wrapped = {
          theme: 'dark',
          CLAUDE_MEM_OPENROUTER_API_KEY: '****',
          CLAUDE_MEM_CLOUD_SYNC_TOKEN: '',
          CLAUDE_MEM_CLOUD_SYNC_USER_ID: '',
          CLAUDE_MEM_CLOUD_SYNC_HUB_URL: '',
          env: {
            CLAUDE_MEM_OPENROUTER_API_KEY: 'sk-or-v1-real',
            CLAUDE_MEM_CLOUD_SYNC_TOKEN: 'sync-token',
            CLAUDE_MEM_CLOUD_SYNC_USER_ID: 'user-1',
            CLAUDE_MEM_CLOUD_SYNC_HUB_URL: 'https://sync.example',
          },
        };
        writeFileSync(settingsPath, JSON.stringify(wrapped));

        const result = SettingsDefaultsManager.loadFromFile(settingsPath, false);

        expect(result.CLAUDE_MEM_OPENROUTER_API_KEY).toBe('sk-or-v1-real');
        expect(result.CLAUDE_MEM_CLOUD_SYNC_TOKEN).toBe('sync-token');
        expect(result.CLAUDE_MEM_CLOUD_SYNC_USER_ID).toBe('user-1');
        expect(result.CLAUDE_MEM_CLOUD_SYNC_HUB_URL).toBe('https://sync.example');
      });

      it('flattens an old viewer\'s wrapped document with no real peers, keeping the env values and dropping the stale copies', () => {
        writeFileSync(settingsPath, JSON.stringify({
          CLAUDE_MEM_OPENROUTER_API_KEY: '****',
          env: { CLAUDE_MEM_OPENROUTER_API_KEY: 'sk-or-v1-real', CLAUDE_MEM_MODEL: 'env-model' },
        }));

        expect(SettingsDefaultsManager.loadFromFile(settingsPath, false).CLAUDE_MEM_OPENROUTER_API_KEY).toBe('sk-or-v1-real');
        expect(JSON.parse(readFileSync(settingsPath, 'utf-8'))).toEqual({
          CLAUDE_MEM_OPENROUTER_API_KEY: 'sk-or-v1-real',
          CLAUDE_MEM_MODEL: 'env-model',
        });
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

      it.each(['bugfix,decision', 'security_alert,security_note', ''])(
        'preserves the non-legacy trigger list %j', (triggerTypes) => {
          writeFileSync(settingsPath, JSON.stringify({
            CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES: triggerTypes,
          }));

          const result = SettingsDefaultsManager.loadFromFile(settingsPath);

          expect(result.CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES).toBe(triggerTypes);
          const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
          expect(parsed.CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES).toBe(triggerTypes);
        },
      );
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

      it('rewrites the direct production Supabase function URL to sync.cmem.ai', () => {
        writeFileSync(settingsPath, JSON.stringify({
          CLAUDE_MEM_CLOUD_SYNC_HUB_URL: 'https://ziczmqtpmaxbornfghye.supabase.co/functions/v1/cmem-sync',
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

    // Older installs had the dated Haiku 4.5 id written in by the default or the
    // installer. Model policy (CLAUDE.md): the note-taker follows the newest Haiku.
    describe('pinned Haiku note-taker migration', () => {
      function migrationWarnings(warnings: string[]): string[] {
        return warnings.filter((line) => line.includes('Migrated Claude model off the pinned'));
      }

      function withEnvFile(contents: string, run: () => void): void {
        const envPath = join(dirname(settingsPath), '.env');
        const saved = process.env.CLAUDE_MEM_ENV_FILE;
        writeFileSync(envPath, contents);
        delete process.env.CLAUDE_MEM_ENV_FILE;
        try {
          run();
        } finally {
          if (saved === undefined) delete process.env.CLAUDE_MEM_ENV_FILE;
          else process.env.CLAUDE_MEM_ENV_FILE = saved;
          rmSync(envPath, { force: true });
        }
      }

      it('ships an alias, not a dated id', () => {
        expect(SettingsDefaultsManager.getAllDefaults().CLAUDE_MEM_MODEL).toBe('haiku');
      });

      it.each(['claude-haiku-4-5-20251001', 'claude-haiku-4-5'])('moves a saved %s to haiku once', (pinned) => {
        writeFileSync(settingsPath, JSON.stringify({
          CLAUDE_MEM_PROVIDER: 'claude',
          CLAUDE_MEM_CLAUDE_AUTH_METHOD: 'subscription',
          CLAUDE_MEM_MODEL: pinned,
        }));

        const first = captureWarnings(() => SettingsDefaultsManager.loadFromFile(settingsPath));

        expect(first.value.CLAUDE_MEM_MODEL).toBe('haiku');
        const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
        expect(parsed.CLAUDE_MEM_MODEL).toBe('haiku');
        expect(parsed.CLAUDE_MEM_CLAUDE_AUTH_METHOD).toBe('subscription');
        const [logLine, ...extra] = migrationWarnings(first.warnings);
        expect(extra).toEqual([]);
        expect(logLine).toContain(`${pinned} to haiku`);

        const second = captureWarnings(() => SettingsDefaultsManager.loadFromFile(settingsPath));
        expect(second.value.CLAUDE_MEM_MODEL).toBe('haiku');
        expect(migrationWarnings(second.warnings)).toEqual([]);
      });

      it('keeps a model the user chose', () => {
        for (const model of ['claude-sonnet-5', 'claude-opus-4-8', 'sonnet', 'claude-haiku-5-5']) {
          const raw = JSON.stringify({ CLAUDE_MEM_MODEL: model });
          writeFileSync(settingsPath, raw);

          const { value, warnings } = captureWarnings(() => SettingsDefaultsManager.loadFromFile(settingsPath));

          expect(value.CLAUDE_MEM_MODEL).toBe(model);
          expect(readFileSync(settingsPath, 'utf-8')).toBe(raw);
          expect(migrationWarnings(warnings)).toEqual([]);
        }
      });

      it('never touches a gateway install, which serves its own model names', () => {
        const raw = JSON.stringify({
          CLAUDE_MEM_CLAUDE_AUTH_METHOD: 'gateway',
          CLAUDE_MEM_MODEL: 'claude-haiku-4-5-20251001',
        });
        writeFileSync(settingsPath, raw);

        const { value, warnings } = captureWarnings(() => SettingsDefaultsManager.loadFromFile(settingsPath));

        expect(value.CLAUDE_MEM_MODEL).toBe('claude-haiku-4-5-20251001');
        expect(readFileSync(settingsPath, 'utf-8')).toBe(raw);
        expect(migrationWarnings(warnings)).toEqual([]);
      });

      it('never touches an install whose claude-mem .env points at a gateway', () => {
        const raw = JSON.stringify({ CLAUDE_MEM_MODEL: 'claude-haiku-4-5-20251001' });
        writeFileSync(settingsPath, raw);
        withEnvFile('ANTHROPIC_BASE_URL=http://127.0.0.1:4000\nANTHROPIC_AUTH_TOKEN=sk-litellm\n', () => {
          const { value, warnings } = captureWarnings(() => SettingsDefaultsManager.loadFromFile(settingsPath));

          expect(value.CLAUDE_MEM_MODEL).toBe('claude-haiku-4-5-20251001');
          expect(readFileSync(settingsPath, 'utf-8')).toBe(raw);
          expect(migrationWarnings(warnings)).toEqual([]);
        });
      });

      it('still moves an install whose .env has an empty ANTHROPIC_BASE_URL', () => {
        writeFileSync(settingsPath, JSON.stringify({ CLAUDE_MEM_MODEL: 'claude-haiku-4-5-20251001' }));
        withEnvFile('ANTHROPIC_BASE_URL=\nANTHROPIC_API_KEY=sk-ant-test\n', () => {
          const { value } = captureWarnings(() => SettingsDefaultsManager.loadFromFile(settingsPath));

          expect(value.CLAUDE_MEM_MODEL).toBe('haiku');
          expect(JSON.parse(readFileSync(settingsPath, 'utf-8')).CLAUDE_MEM_MODEL).toBe('haiku');
        });
      });

      it('never touches a gateway .env saved with a BOM', () => {
        const raw = JSON.stringify({ CLAUDE_MEM_MODEL: 'claude-haiku-4-5-20251001' });
        writeFileSync(settingsPath, raw);
        withEnvFile('\uFEFFANTHROPIC_BASE_URL=http://127.0.0.1:4000\n', () => {
          const { value } = captureWarnings(() => SettingsDefaultsManager.loadFromFile(settingsPath));

          expect(value.CLAUDE_MEM_MODEL).toBe('claude-haiku-4-5-20251001');
          expect(readFileSync(settingsPath, 'utf-8')).toBe(raw);
        });
      });

      it('rewrites in memory only when read-only', () => {
        const raw = JSON.stringify({ CLAUDE_MEM_MODEL: 'claude-haiku-4-5-20251001' });
        writeFileSync(settingsPath, raw);

        const value = SettingsDefaultsManager.loadFromFile(settingsPath, false, { readOnly: true });

        expect(value.CLAUDE_MEM_MODEL).toBe('haiku');
        expect(readFileSync(settingsPath, 'utf-8')).toBe(raw);
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
      // one place only would leave openclaw installs on a dead id.
      it('keeps the openclaw installer copies of the default in sync', () => {
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

    // Image capture became on by default. Every settings.json seeded while it
    // was off holds 'false', and a persisted value wins over DEFAULTS, so the
    // new default would never reach those installs without this one move. A
    // 'false' saved afterwards (the "Keep images" switch) must stay, and a
    // file the move cannot rewrite must keep saying what the worker does.
    describe('image capture default-on migration', () => {
      const KEY = 'CLAUDE_MEM_MEDIA_CAPTURE_ENABLED';

      function migrationWarnings(warnings: string[]): string[] {
        return warnings.filter((line) => line.includes(KEY));
      }

      it('ships capture on and inference off', () => {
        const defaults = SettingsDefaultsManager.getAllDefaults();
        expect(defaults[KEY]).toBe('true');
        expect(defaults.CLAUDE_MEM_MEDIA_INFERENCE_ENABLED).toBe('false');
      });

      it('seeds a fresh settings file with capture on', () => {
        const result = SettingsDefaultsManager.loadFromFile(settingsPath, false);

        expect(result[KEY]).toBe('true');
        expect(JSON.parse(readFileSync(settingsPath, 'utf-8'))[KEY]).toBe('true');
      });

      it('moves the seeded false to true once, with one log line, and leaves inference off', () => {
        writeFileSync(settingsPath, JSON.stringify({
          CLAUDE_MEM_PROVIDER: 'openrouter',
          [KEY]: 'false',
          CLAUDE_MEM_MEDIA_INFERENCE_ENABLED: 'false',
        }));

        const first = captureWarnings(() => SettingsDefaultsManager.loadFromFile(settingsPath, false));

        expect(first.value[KEY]).toBe('true');
        expect(first.value.CLAUDE_MEM_MEDIA_INFERENCE_ENABLED).toBe('false');
        expect(JSON.parse(readFileSync(settingsPath, 'utf-8'))).toEqual({
          CLAUDE_MEM_PROVIDER: 'openrouter',
          [KEY]: 'true',
          CLAUDE_MEM_MEDIA_INFERENCE_ENABLED: 'false',
        });
        const [logLine, ...extra] = migrationWarnings(first.warnings);
        expect(extra).toEqual([]);
        expect(logLine).toContain('off the old false default to true:');

        const second = captureWarnings(() => SettingsDefaultsManager.loadFromFile(settingsPath, false));
        expect(second.value[KEY]).toBe('true');
        expect(migrationWarnings(second.warnings)).toEqual([]);
      });

      it.each([
        ['after the seeded value was moved', JSON.stringify({ [KEY]: 'false' })],
        ['on an install that already had capture on', JSON.stringify({ [KEY]: 'true' })],
        ['on a settings file created fresh', null],
      ])('keeps "Keep images" off when the user turns it off %s', (_label, initial) => {
        if (initial !== null) writeFileSync(settingsPath, initial);
        SettingsDefaultsManager.loadFromFile(settingsPath, false);

        writeFileSync(settingsPath, JSON.stringify({ [KEY]: 'false' }));
        const { value, warnings } = captureWarnings(() => SettingsDefaultsManager.loadFromFile(settingsPath, false));

        expect(value[KEY]).toBe('false');
        expect(JSON.parse(readFileSync(settingsPath, 'utf-8'))[KEY]).toBe('false');
        expect(migrationWarnings(warnings)).toEqual([]);
      });

      it('leaves a JSON boolean false written by hand untouched', () => {
        const raw = JSON.stringify({ [KEY]: false });
        writeFileSync(settingsPath, raw);

        const result = SettingsDefaultsManager.loadFromFile(settingsPath, false);

        expect(result[KEY]).toBe('false');
        expect(readFileSync(settingsPath, 'utf-8')).toBe(raw);
      });

      it('a read-only load keeps the saved false and writes nothing', () => {
        const raw = JSON.stringify({ [KEY]: 'false' });
        writeFileSync(settingsPath, raw);

        const result = SettingsDefaultsManager.loadFromFile(settingsPath, false, { readOnly: true });

        expect(result[KEY]).toBe('false');
        expect(readFileSync(settingsPath, 'utf-8')).toBe(raw);
        // The worker's writable load still gets its one chance afterwards.
        expect(SettingsDefaultsManager.loadFromFile(settingsPath, false)[KEY]).toBe('true');
      });

      it('keeps the saved false, warning once, when the move cannot be saved', () => {
        if (process.platform === 'win32' || process.getuid?.() === 0) return;
        const storeDir = join(tempDir, 'read-only-store');
        mkdirSync(storeDir);
        const storedSettings = join(storeDir, 'settings.json');
        const raw = JSON.stringify({ [KEY]: 'false' });
        writeFileSync(storedSettings, raw);
        symlinkSync(storedSettings, settingsPath);
        chmodSync(storeDir, 0o555);
        try {
          const loads = [1, 2, 3].map(() => captureWarnings(() => SettingsDefaultsManager.loadFromFile(settingsPath, false)));

          for (const { value } of loads) expect(value[KEY]).toBe('false');
          const failures = loads.flatMap(({ warnings }) => migrationWarnings(warnings));
          expect(failures).toHaveLength(1);
          expect(failures[0]).toContain('keeping the saved false');
          expect(readFileSync(storedSettings, 'utf-8')).toBe(raw);
        } finally {
          chmodSync(storeDir, 0o755);
        }
      });
    });

    // loadFromFile only carries keys declared in DEFAULTS, so before the Pro
    // sign-in keys were declared, an installer-written settings.json lost
    // them on every load (the round-trip-loss gap fixed by the install-first
    // login flow plan, Phase 4).
    // The installer's email opt-in reads these back to avoid asking twice;
    // an undeclared key would be dropped on the next settings rewrite.
    it('round-trips the installer email opt-in keys', () => {
      const signup = {
        CLAUDE_MEM_ONLINE_SIGNUP_EMAIL: 'dev@example.com',
        CLAUDE_MEM_ONLINE_SIGNUP_NOTE: 'onboarding a team',
        CLAUDE_MEM_ONLINE_SIGNUP_AT: '2026-11-07T12:00:00.000Z',
        CLAUDE_MEM_ONLINE_SIGNUP_SENT: 'false',
      };
      writeFileSync(settingsPath, JSON.stringify({ env: signup }));

      const result = SettingsDefaultsManager.loadFromFile(settingsPath);

      expect(result).toMatchObject(signup);
      expect(JSON.parse(readFileSync(settingsPath, 'utf-8'))).toMatchObject(signup);
    });

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

        expect(result).toEqual(defaultsForSettingsPath(tempDir));
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

        expect(result.CLAUDE_MEM_MODEL).toBe('bom-model');
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
      expect(defaults1.CLAUDE_MEM_FILE_READ_GATE_ENABLED).toBe('true');
    });

    it('keeps every viewer default aligned except the per-install worker port', () => {
      const defaults = SettingsDefaultsManager.getAllDefaults();

      for (const key of Object.keys(VIEWER_DEFAULT_SETTINGS) as Array<keyof typeof VIEWER_DEFAULT_SETTINGS>) {
        if (key !== 'CLAUDE_MEM_WORKER_PORT') expect(defaults[key]).toBe(VIEWER_DEFAULT_SETTINGS[key]);
      }
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
      expect(SettingsDefaultsManager.get('CLAUDE_MEM_MODEL')).toBe('haiku');
      const expectedPort = SettingsDefaultsManager.getAllDefaults().CLAUDE_MEM_WORKER_PORT;
      expect(SettingsDefaultsManager.get('CLAUDE_MEM_WORKER_PORT')).toBe(expectedPort);
    });

    it('expands a leading ~ in CLAUDE_MEM_DATA_DIR from the environment', () => {
      process.env.CLAUDE_MEM_DATA_DIR = '~/x';
      expect(SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR')).toBe(join(homedir(), 'x'));
    });
  });

  describe('getInt', () => {
    it('should return integer value for numeric string', () => {
      const expectedPort = Number(SettingsDefaultsManager.getAllDefaults().CLAUDE_MEM_WORKER_PORT);
      expect(SettingsDefaultsManager.getInt('CLAUDE_MEM_WORKER_PORT')).toBe(expectedPort);
      expect(SettingsDefaultsManager.getInt('CLAUDE_MEM_CONTEXT_OBSERVATIONS')).toBe(50);
    });
  });

  describe('environment variable overrides', () => {
    it('should prioritize env var over file setting', () => {
      const fileSettings = {
        CLAUDE_MEM_WORKER_PORT: '12345',
      };
      writeFileSync(settingsPath, JSON.stringify(fileSettings));
      process.env.CLAUDE_MEM_WORKER_PORT = '54321';

      const result = SettingsDefaultsManager.loadFromFile(settingsPath);

      expect(result.CLAUDE_MEM_WORKER_PORT).toBe('54321');
    });

    it('should prioritize env var over default', () => {
      process.env.CLAUDE_MEM_WORKER_PORT = '99999';

      const result = SettingsDefaultsManager.loadFromFile(settingsPath);

      expect(result.CLAUDE_MEM_WORKER_PORT).toBe('99999');
    });

    it('should apply env var override even on file parse error', () => {
      writeFileSync(settingsPath, 'invalid json {{{');
      process.env.CLAUDE_MEM_WORKER_PORT = '88888';

      const result = SettingsDefaultsManager.loadFromFile(settingsPath);

      expect(result.CLAUDE_MEM_WORKER_PORT).toBe('88888');
    });
  });

  describe('CLAUDE_MEM_WORKER_HOST localhost normalization (#2992)', () => {
    // On modern Windows resolvers 'localhost' resolves IPv6-first while
    // server.listen(port, 'localhost') binds ::1 only, so a 'localhost'
    // host value can put the hook client and the worker on different
    // loopback families. The manager pins it to the IPv4 loopback.
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

  describe('CLAUDE_MEM_CHROMA_UVX_PATH (#4195)', () => {
    // `pip install uv` puts uvx.exe in a Python Scripts folder that is not one
    // of uv's own install dirs, so on Windows the setting is the way to pick it.
    const fileUvx = 'C:\\Users\\Jane Doe\\AppData\\Local\\Programs\\Python\\Python313\\Scripts\\uvx.exe';
    const envUvx = 'D:\\Tools\\uv\\uvx.exe';
    let originalUvxEnv: string | undefined;

    beforeEach(() => {
      originalUvxEnv = process.env.CLAUDE_MEM_CHROMA_UVX_PATH;
      delete process.env.CLAUDE_MEM_CHROMA_UVX_PATH;
    });

    afterEach(() => {
      if (originalUvxEnv === undefined) {
        delete process.env.CLAUDE_MEM_CHROMA_UVX_PATH;
      } else {
        process.env.CLAUDE_MEM_CHROMA_UVX_PATH = originalUvxEnv;
      }
    });

    it('defaults to empty, so uv\'s usual install folders are searched', () => {
      expect(SettingsDefaultsManager.getAllDefaults().CLAUDE_MEM_CHROMA_UVX_PATH).toBe('');
    });

    it('reads the path from settings.json, spaces included', () => {
      writeFileSync(settingsPath, JSON.stringify({ CLAUDE_MEM_CHROMA_UVX_PATH: fileUvx }));

      expect(SettingsDefaultsManager.loadFromFile(settingsPath).CLAUDE_MEM_CHROMA_UVX_PATH).toBe(fileUvx);
    });

    it('lets the environment variable override settings.json', () => {
      writeFileSync(settingsPath, JSON.stringify({ CLAUDE_MEM_CHROMA_UVX_PATH: fileUvx }));
      process.env.CLAUDE_MEM_CHROMA_UVX_PATH = envUvx;

      expect(SettingsDefaultsManager.loadFromFile(settingsPath).CLAUDE_MEM_CHROMA_UVX_PATH).toBe(envUvx);
    });
  });
});

describe('Chroma embedding function default', () => {
  it('keeps chroma-mcp\'s own default so existing installs are unchanged', () => {
    expect(SettingsDefaultsManager.getAllDefaults().CLAUDE_MEM_CHROMA_EMBEDDING_FUNCTION).toBe('default');
  });
});

describe('embedding model default', () => {
  it('keeps all-MiniLM-L6-v2, the model Chroma embeds with', () => {
    expect(SettingsDefaultsManager.getAllDefaults().CLAUDE_MEM_EMBEDDING_MODEL).toBe('all-MiniLM-L6-v2');
  });
});

describe('transcript-watch config path follows the data dir', () => {
  const keys = ['CLAUDE_MEM_DATA_DIR', 'CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH'] as const;
  let saved: Record<string, string | undefined>;
  let tempDir: string;
  let settingsPath: string;
  const legacyDefault = SettingsDefaultsManager.getAllDefaults().CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH;

  beforeEach(() => {
    saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    for (const key of keys) delete process.env[key];
    tempDir = join(tmpdir(), `transcripts-path-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    settingsPath = join(tempDir, 'settings.json');
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('resolves under CLAUDE_MEM_DATA_DIR from the environment', () => {
    process.env.CLAUDE_MEM_DATA_DIR = join(tempDir, 'env-data');
    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
    expect(settings.CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH).toBe(join(tempDir, 'env-data', 'transcript-watch.json'));
  });

  it('resolves under CLAUDE_MEM_DATA_DIR from settings.json, also when the file persisted the old default', () => {
    const dataDir = join(tempDir, 'file-data');
    writeFileSync(settingsPath, JSON.stringify({ CLAUDE_MEM_DATA_DIR: dataDir, CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH: legacyDefault }));
    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
    expect(settings.CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH).toBe(join(dataDir, 'transcript-watch.json'));
  });

  it('expands a ~ data dir from the environment to an absolute path under home', () => {
    process.env.CLAUDE_MEM_DATA_DIR = '~/x';
    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
    expect(settings.CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH).toBe(join(homedir(), 'x', 'transcript-watch.json'));
  });

  it('expands a ~ data dir from settings.json to an absolute path under home', () => {
    writeFileSync(settingsPath, JSON.stringify({ CLAUDE_MEM_DATA_DIR: '~/x', CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH: legacyDefault }));
    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
    expect(settings.CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH).toBe(join(homedir(), 'x', 'transcript-watch.json'));
  });

  it('keeps an explicitly configured path', () => {
    const custom = join(tempDir, 'custom', 'watch.json');
    writeFileSync(settingsPath, JSON.stringify({ CLAUDE_MEM_DATA_DIR: join(tempDir, 'file-data'), CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH: custom }));
    expect(SettingsDefaultsManager.loadFromFile(settingsPath).CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH).toBe(custom);
  });

  it('is unchanged for the default data dir', () => {
    expect(SettingsDefaultsManager.loadFromFile(settingsPath).CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH).toBe(legacyDefault);
  });
});
