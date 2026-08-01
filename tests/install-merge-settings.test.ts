import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { mergeSettings } from '../src/npx-cli/commands/install.js';

let tempDir: string;
let settingsPath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'claude-mem-merge-settings-'));
  settingsPath = join(tempDir, 'settings.json');
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('mergeSettings: corrupt-document write refusal', () => {
  it('returns false and leaves the truncated bytes exact (reproduction of #3080)', () => {
    const corruptBytes = '{"CLAUDE_MEM_MODEL":"claude-opus-4-8"';
    writeFileSync(settingsPath, corruptBytes, 'utf-8');

    const result = mergeSettings({ CLAUDE_MEM_WORKER_PORT: '37779' }, settingsPath);

    expect(result).toBe(false);
    expect(readFileSync(settingsPath, 'utf-8')).toBe(corruptBytes);
  });

  it('returns false and leaves bytes exact for an empty file (parse failure)', () => {
    writeFileSync(settingsPath, '', 'utf-8');

    const result = mergeSettings({ CLAUDE_MEM_WORKER_PORT: '37779' }, settingsPath);

    expect(result).toBe(false);
    expect(readFileSync(settingsPath, 'utf-8')).toBe('');
  });

  it('returns false and leaves bytes exact for a whitespace-only file (parse failure)', () => {
    const original = '   \n\t  ';
    writeFileSync(settingsPath, original, 'utf-8');

    const result = mergeSettings({ CLAUDE_MEM_WORKER_PORT: '37779' }, settingsPath);

    expect(result).toBe(false);
    expect(readFileSync(settingsPath, 'utf-8')).toBe(original);
  });
});

describe('mergeSettings: non-record write refusal', () => {
  it('returns false and leaves bytes exact for null', () => {
    const original = 'null';
    writeFileSync(settingsPath, original, 'utf-8');

    const result = mergeSettings({ CLAUDE_MEM_WORKER_PORT: '37779' }, settingsPath);

    expect(result).toBe(false);
    expect(readFileSync(settingsPath, 'utf-8')).toBe(original);
  });

  it('returns false and leaves bytes exact for a boolean', () => {
    const original = 'true';
    writeFileSync(settingsPath, original, 'utf-8');

    const result = mergeSettings({ CLAUDE_MEM_WORKER_PORT: '37779' }, settingsPath);

    expect(result).toBe(false);
    expect(readFileSync(settingsPath, 'utf-8')).toBe(original);
  });

  it('returns false and leaves bytes exact for a number', () => {
    const original = '42';
    writeFileSync(settingsPath, original, 'utf-8');

    const result = mergeSettings({ CLAUDE_MEM_WORKER_PORT: '37779' }, settingsPath);

    expect(result).toBe(false);
    expect(readFileSync(settingsPath, 'utf-8')).toBe(original);
  });

  it('returns false and leaves bytes exact for a string', () => {
    const original = '"just a string"';
    writeFileSync(settingsPath, original, 'utf-8');

    const result = mergeSettings({ CLAUDE_MEM_WORKER_PORT: '37779' }, settingsPath);

    expect(result).toBe(false);
    expect(readFileSync(settingsPath, 'utf-8')).toBe(original);
  });

  it('returns false and leaves bytes exact for a root array containing ["sentinel"]', () => {
    const original = '["sentinel"]';
    writeFileSync(settingsPath, original, 'utf-8');

    const result = mergeSettings({ CLAUDE_MEM_WORKER_PORT: '37779' }, settingsPath);

    expect(result).toBe(false);
    expect(readFileSync(settingsPath, 'utf-8')).toBe(original);
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
});
