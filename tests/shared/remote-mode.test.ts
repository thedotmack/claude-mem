import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import {
  isRemoteModeActive,
  applyRemoteModeDerivations,
  remoteBootstrapTimeoutMs,
  isClaudeCodeRemoteContainer,
  REMOTE_DEFAULT_HUB_URL,
  REMOTE_DEVICE_NAME,
  REMOTE_INFERENCE_MODEL,
} from '../../src/shared/remote-mode.js';

const TOKEN = 'cm_pro_0123456789abcdef01234567';
const USER_ID = '9f8e7d6c-1234-4abc-9def-0123456789ab';

// Every key these tests may set through the real process.env.
const ENV_KEYS = [
  'CLAUDE_MEM_REMOTE_MODE',
  'CLAUDE_MEM_PRO_TOKEN',
  'CLAUDE_MEM_PRO_USER_ID',
  'CLAUDE_MEM_PRO_ORIGIN',
  'CLAUDE_MEM_REMOTE_BOOTSTRAP_TIMEOUT_MS',
  'CLAUDE_MEM_CLOUD_SYNC_TOKEN',
  'CLAUDE_MEM_CLOUD_SYNC_USER_ID',
  'CLAUDE_MEM_CLOUD_SYNC_HUB_URL',
  'CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME',
  'CLAUDE_MEM_PROVIDER',
  'CLAUDE_MEM_OPENROUTER_API_KEY',
  'CLAUDE_MEM_OPENROUTER_BASE_URL',
  'CLAUDE_MEM_OPENROUTER_MODEL',
  'CLAUDE_MEM_CHROMA_ENABLED',
  'CLAUDE_MEM_DATA_DIR',
] as const;

describe('remote-mode', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  const defaults = () => SettingsDefaultsManager.getAllDefaults();

  const withCreds = () => {
    const s = defaults();
    s.CLAUDE_MEM_PRO_TOKEN = TOKEN;
    s.CLAUDE_MEM_PRO_USER_ID = USER_ID;
    return s;
  };

  describe('isRemoteModeActive', () => {
    it('is inactive without credentials', () => {
      expect(isRemoteModeActive(defaults())).toBe(false);
    });

    it('is inactive with only one credential', () => {
      const s = defaults();
      s.CLAUDE_MEM_PRO_TOKEN = TOKEN;
      expect(isRemoteModeActive(s)).toBe(false);
    });

    it('activates on the credential pair (auto default)', () => {
      expect(isRemoteModeActive(withCreds())).toBe(true);
    });

    it('honors the false kill switch despite credentials', () => {
      const s = withCreds();
      s.CLAUDE_MEM_REMOTE_MODE = 'false';
      expect(isRemoteModeActive(s)).toBe(false);
    });

    it('reads credentials env-first (SearchRoutes cache loads without env overrides)', () => {
      process.env.CLAUDE_MEM_PRO_TOKEN = TOKEN;
      process.env.CLAUDE_MEM_PRO_USER_ID = USER_ID;
      expect(isRemoteModeActive(defaults())).toBe(true);
    });

    it('reads the kill switch env-first', () => {
      process.env.CLAUDE_MEM_REMOTE_MODE = 'false';
      expect(isRemoteModeActive(withCreds())).toBe(false);
    });
  });

  describe('applyRemoteModeDerivations', () => {
    it('returns settings unchanged when inactive', () => {
      const s = defaults();
      expect(applyRemoteModeDerivations(s, defaults())).toEqual(s);
    });

    it('expands the credential pair into cloud sync, inference, chroma, and device name', () => {
      const derived = applyRemoteModeDerivations(withCreds(), defaults());

      expect(derived.CLAUDE_MEM_CLOUD_SYNC_TOKEN).toBe(TOKEN);
      expect(derived.CLAUDE_MEM_CLOUD_SYNC_USER_ID).toBe(USER_ID);
      expect(derived.CLAUDE_MEM_CLOUD_SYNC_HUB_URL).toBe(REMOTE_DEFAULT_HUB_URL);
      expect(derived.CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME).toBe(REMOTE_DEVICE_NAME);
      expect(derived.CLAUDE_MEM_PROVIDER).toBe('openrouter');
      expect(derived.CLAUDE_MEM_OPENROUTER_API_KEY).toBe(TOKEN);
      expect(derived.CLAUDE_MEM_OPENROUTER_BASE_URL).toBe('https://cmem.ai/api/inference/v1');
      expect(derived.CLAUDE_MEM_OPENROUTER_MODEL).toBe(REMOTE_INFERENCE_MODEL);
      expect(derived.CLAUDE_MEM_CHROMA_ENABLED).toBe('false');
    });

    it('respects a custom Pro origin', () => {
      const s = withCreds();
      s.CLAUDE_MEM_PRO_ORIGIN = 'https://staging.cmem.ai/';
      const derived = applyRemoteModeDerivations(s, defaults());
      expect(derived.CLAUDE_MEM_OPENROUTER_BASE_URL).toBe('https://staging.cmem.ai/api/inference/v1');
    });

    it('never overwrites explicitly set cloud sync values', () => {
      const s = withCreds();
      s.CLAUDE_MEM_CLOUD_SYNC_TOKEN = 'cm_pro_other';
      s.CLAUDE_MEM_CLOUD_SYNC_HUB_URL = 'https://hub.example.com';
      const derived = applyRemoteModeDerivations(s, defaults());
      expect(derived.CLAUDE_MEM_CLOUD_SYNC_TOKEN).toBe('cm_pro_other');
      expect(derived.CLAUDE_MEM_CLOUD_SYNC_HUB_URL).toBe('https://hub.example.com');
    });

    it('leaves an explicitly chosen provider alone', () => {
      const s = withCreds();
      s.CLAUDE_MEM_PROVIDER = 'gemini';
      const derived = applyRemoteModeDerivations(s, defaults());
      expect(derived.CLAUDE_MEM_PROVIDER).toBe('gemini');
      expect(derived.CLAUDE_MEM_OPENROUTER_API_KEY).toBe('');
    });

    it('does not derive the gateway model for a user-supplied base URL', () => {
      const s = withCreds();
      s.CLAUDE_MEM_OPENROUTER_BASE_URL = 'https://api.deepseek.com';
      const derived = applyRemoteModeDerivations(s, defaults());
      expect(derived.CLAUDE_MEM_OPENROUTER_MODEL).toBe(defaults().CLAUDE_MEM_OPENROUTER_MODEL);
    });

    it('honors an explicit env re-enable of Chroma', () => {
      process.env.CLAUDE_MEM_CHROMA_ENABLED = 'true';
      const derived = applyRemoteModeDerivations(withCreds(), defaults());
      expect(derived.CLAUDE_MEM_CHROMA_ENABLED).toBe('true');
    });

    it('honors an explicit env device name', () => {
      process.env.CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME = 'my-box';
      const s = withCreds();
      s.CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME = 'my-box';
      const derived = applyRemoteModeDerivations(s, defaults());
      expect(derived.CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME).toBe('my-box');
    });
  });

  describe('loadFromFile integration', () => {
    let tempDir: string;
    let settingsPath: string;

    beforeEach(() => {
      tempDir = join(tmpdir(), `remote-mode-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      mkdirSync(tempDir, { recursive: true });
      settingsPath = join(tempDir, 'settings.json');
    });

    afterEach(() => {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    });

    it('derives the full connection from env credentials on a fresh settings file', () => {
      process.env.CLAUDE_MEM_REMOTE_MODE = 'true';
      process.env.CLAUDE_MEM_PRO_TOKEN = TOKEN;
      process.env.CLAUDE_MEM_PRO_USER_ID = USER_ID;

      const result = SettingsDefaultsManager.loadFromFile(settingsPath);

      expect(result.CLAUDE_MEM_CLOUD_SYNC_TOKEN).toBe(TOKEN);
      expect(result.CLAUDE_MEM_CLOUD_SYNC_USER_ID).toBe(USER_ID);
      expect(result.CLAUDE_MEM_CLOUD_SYNC_HUB_URL).toBe(REMOTE_DEFAULT_HUB_URL);
      expect(result.CLAUDE_MEM_PROVIDER).toBe('openrouter');
      expect(result.CLAUDE_MEM_CHROMA_ENABLED).toBe('false');
    });

    it('never persists derived credentials into settings.json', () => {
      process.env.CLAUDE_MEM_PRO_TOKEN = TOKEN;
      process.env.CLAUDE_MEM_PRO_USER_ID = USER_ID;

      SettingsDefaultsManager.loadFromFile(settingsPath);

      const onDisk = readFileSync(settingsPath, 'utf-8');
      expect(onDisk).not.toContain(TOKEN);
      expect(onDisk).not.toContain(USER_ID);
    });

    it('applies no derivation on the raw-file path (applyEnvOverrides=false)', () => {
      process.env.CLAUDE_MEM_PRO_TOKEN = TOKEN;
      process.env.CLAUDE_MEM_PRO_USER_ID = USER_ID;

      const raw = SettingsDefaultsManager.loadFromFile(settingsPath, false);
      expect(raw.CLAUDE_MEM_CLOUD_SYNC_TOKEN).toBe('');
      expect(raw.CLAUDE_MEM_PROVIDER).toBe('claude');
    });
  });

  describe('remoteBootstrapTimeoutMs', () => {
    it('defaults to 20s', () => {
      expect(remoteBootstrapTimeoutMs(defaults())).toBe(20000);
    });

    it('parses an override and rejects garbage', () => {
      const s = defaults();
      s.CLAUDE_MEM_REMOTE_BOOTSTRAP_TIMEOUT_MS = '45000';
      expect(remoteBootstrapTimeoutMs(s)).toBe(45000);
      s.CLAUDE_MEM_REMOTE_BOOTSTRAP_TIMEOUT_MS = 'soon';
      expect(remoteBootstrapTimeoutMs(s)).toBe(20000);
      s.CLAUDE_MEM_REMOTE_BOOTSTRAP_TIMEOUT_MS = '-5';
      expect(remoteBootstrapTimeoutMs(s)).toBe(20000);
    });
  });

  describe('isClaudeCodeRemoteContainer', () => {
    it('detects the container marker values', () => {
      expect(isClaudeCodeRemoteContainer({ CLAUDE_CODE_REMOTE: 'true' })).toBe(true);
      expect(isClaudeCodeRemoteContainer({ CLAUDE_CODE_REMOTE: '1' })).toBe(true);
      expect(isClaudeCodeRemoteContainer({ CLAUDE_CODE_REMOTE: 'false' })).toBe(false);
      expect(isClaudeCodeRemoteContainer({})).toBe(false);
    });
  });
});
