import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildTrialReadySettings, mergeSettings } from '../src/npx-cli/commands/install.js';

let tempDir: string;
let settingsPath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'claude-mem-merge-settings-'));
  settingsPath = join(tempDir, 'settings.json');
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/**
 * #3080: the installer used to reset an unreadable settings.json to `{}` and
 * write it back, destroying the user's settings. It now moves the unreadable
 * file aside (bytes kept exactly) and writes a fresh document, so a corrupt
 * file never stops setup or drops the sign-in's memory key.
 */
function quarantinedFiles(): string[] {
  return readdirSync(tempDir).filter(name => name.startsWith('settings.json.corrupt-'));
}

function expectQuarantinedThenSaved(originalBytes: string): void {
  writeFileSync(settingsPath, originalBytes, 'utf-8');

  expect(mergeSettings({ CLAUDE_MEM_WORKER_PORT: '37779' }, settingsPath)).toBe(true);

  const quarantined = quarantinedFiles();
  expect(quarantined).toHaveLength(1);
  expect(readFileSync(join(tempDir, quarantined[0]), 'utf-8')).toBe(originalBytes);
  expect(JSON.parse(readFileSync(settingsPath, 'utf-8'))).toEqual({ CLAUDE_MEM_WORKER_PORT: '37779' });
}

describe('mergeSettings: unreadable settings.json is quarantined, never reset', () => {
  it('keeps the truncated bytes exactly and saves the update (reproduction of #3080)', () => {
    expectQuarantinedThenSaved('{"CLAUDE_MEM_MODEL":"claude-opus-4-8"');
  });

  it('keeps a multi-key partial document intact in the quarantine copy', () => {
    expectQuarantinedThenSaved('{"CLAUDE_MEM_MODEL":"claude-opus-4-8","CLAUDE_MEM_PROVIDER":"gemini"');
  });

  it('handles an empty file (parse failure)', () => {
    expectQuarantinedThenSaved('');
  });

  it('handles a whitespace-only file (parse failure)', () => {
    expectQuarantinedThenSaved('   \n\t  ');
  });

  it('handles non-object JSON documents (null, boolean, number, string, root array)', () => {
    for (const original of ['null', 'true', '42', '"just a string"', '["sentinel"]']) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = mkdtempSync(join(tmpdir(), 'claude-mem-merge-settings-'));
      settingsPath = join(tempDir, 'settings.json');
      expectQuarantinedThenSaved(original);
    }
  });

  it('never stops the sign-in memory key from saving over a corrupt file', () => {
    writeFileSync(settingsPath, '{"CLAUDE_MEM_PROVIDER":', 'utf-8');
    const trialSettings = buildTrialReadySettings({
      setupToken: 'setup-token',
      userId: 'user-1',
      hubUrl: 'https://hub.example.test',
      memoryKey: 'cm_pro_trial_memory_key',
      memoryBaseUrl: 'https://gateway.example.test/v1',
      memoryModel: 'gateway-model',
      plan: 'pro',
      trialEndsAt: null,
    } as Parameters<typeof buildTrialReadySettings>[0], 'test-device');

    expect(mergeSettings(trialSettings, settingsPath)).toBe(true);

    const written = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(written.CLAUDE_MEM_PRO_MEMORY_KEY).toBe('cm_pro_trial_memory_key');
    expect(written.CLAUDE_MEM_PRO_TRIAL_STATE).toBe('active');
    expect(quarantinedFiles()).toHaveLength(1);
  });
});

describe('mergeSettings: flat-record merge preservation', () => {
  it('changes only the requested root key; all unmentioned values remain deeply equal', () => {
    const original = {
      CLAUDE_MEM_MODEL: 'claude-opus-4-5',
      UNRELATED_KEY: 'keep-me',
      nested: { deep: 'value', count: 3 },
    };
    writeFileSync(settingsPath, JSON.stringify(original, null, 2), 'utf-8');

    const result = mergeSettings({ CLAUDE_MEM_MODEL: 'claude-opus-4-8' }, settingsPath);

    expect(result).toBe(true);
    const written = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(written.CLAUDE_MEM_MODEL).toBe('claude-opus-4-8');
    expect(written.UNRELATED_KEY).toBe('keep-me');
    expect(written.nested).toEqual({ deep: 'value', count: 3 });
  });
});

describe('mergeSettings: nested-env merge preservation', () => {
  it('changes only the requested env key; root peers and unmentioned env values remain deeply equal', () => {
    const original = {
      theme: 'dark',
      permissions: { defaultMode: 'auto' },
      env: {
        CLAUDE_MEM_MODEL: 'claude-opus-4-5',
        EXISTING_ENV_VAR: 'keep-me',
      },
    };
    writeFileSync(settingsPath, JSON.stringify(original, null, 2), 'utf-8');

    const result = mergeSettings({ CLAUDE_MEM_MODEL: 'claude-opus-4-8' }, settingsPath);

    expect(result).toBe(true);
    const written = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(written.theme).toBe('dark');
    expect(written.permissions).toEqual({ defaultMode: 'auto' });
    expect(written.env.CLAUDE_MEM_MODEL).toBe('claude-opus-4-8');
    expect(written.env.EXISTING_ENV_VAR).toBe('keep-me');
  });

  it('keeps an object-valued flat env setting at the root after migration', () => {
    const original = {
      env: { enabled: true, sources: ['local'] },
      CLAUDE_MEM_MODEL: 'claude-opus-4-5',
    };
    writeFileSync(settingsPath, JSON.stringify(original), 'utf-8');

    expect(mergeSettings({ CLAUDE_MEM_MODEL: 'claude-opus-4-8' }, settingsPath)).toBe(true);

    const written = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(written.env).toEqual(original.env);
    expect(written.CLAUDE_MEM_MODEL).toBe('claude-opus-4-8');
  });

  it('keeps nested claude-mem settings nested beside unrelated root Claude settings', () => {
    const original = {
      CLAUDE_CODE_MAX_OUTPUT_CHARS: '12000',
      env: { CLAUDE_MEM_MODEL: 'claude-opus-4-5', KEEP_ME: 'yes' },
    };
    writeFileSync(settingsPath, JSON.stringify(original), 'utf-8');

    expect(mergeSettings({ CLAUDE_MEM_MODEL: 'claude-opus-4-8' }, settingsPath)).toBe(true);

    const written = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(written.CLAUDE_CODE_MAX_OUTPUT_CHARS).toBe('12000');
    expect(written.CLAUDE_MEM_MODEL).toBeUndefined();
    expect(written.env).toEqual({ CLAUDE_MEM_MODEL: 'claude-opus-4-8', KEEP_ME: 'yes' });
  });

  it('keeps an existing flat claude-mem setting at the root when env has only Claude Code settings', () => {
    const original = {
      CLAUDE_MEM_MODEL: 'claude-opus-4-5',
      env: { CLAUDE_CODE_PATH: '~/bin/claude' },
    };
    writeFileSync(settingsPath, JSON.stringify(original), 'utf-8');

    expect(mergeSettings({ CLAUDE_MEM_MODEL: 'claude-opus-4-8' }, settingsPath)).toBe(true);

    const written = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(written.CLAUDE_MEM_MODEL).toBe('claude-opus-4-8');
    expect(written.env).toEqual({ CLAUDE_CODE_PATH: '~/bin/claude' });
  });
});

describe('mergeSettings: env-array routing boundary', () => {
  it('treats {"env":["sentinel"],"theme":"dark"} as flat; array and theme remain; requested setting is written at root', () => {
    const original = { env: ['sentinel'], theme: 'dark' };
    writeFileSync(settingsPath, JSON.stringify(original), 'utf-8');

    const result = mergeSettings({ CLAUDE_MEM_WORKER_PORT: '37779' }, settingsPath);

    expect(result).toBe(true);
    const written = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(written.env).toEqual(['sentinel']);
    expect(written.theme).toBe('dark');
    expect(written.CLAUDE_MEM_WORKER_PORT).toBe('37779');
  });
});

describe('mergeSettings: missing-file creation', () => {
  it('creates the parent directory and writes a flat settings document when no file or parent exists', () => {
    const deepPath = join(tempDir, 'nested', 'subdir', 'settings.json');

    const result = mergeSettings({ CLAUDE_MEM_WORKER_PORT: '37779' }, deepPath);

    expect(result).toBe(true);
    const written = JSON.parse(readFileSync(deepPath, 'utf-8'));
    expect(written.CLAUDE_MEM_WORKER_PORT).toBe('37779');
  });

  it('returns false when the settings parent cannot be created or written', () => {
    const blockedParent = join(tempDir, 'blocked');
    writeFileSync(blockedParent, 'not a directory', 'utf-8');
    const blockedPath = join(blockedParent, 'settings.json');

    expect(mergeSettings({ CLAUDE_MEM_WORKER_PORT: '37779' }, blockedPath)).toBe(false);
    expect(readFileSync(blockedParent, 'utf-8')).toBe('not a directory');
  });
});
