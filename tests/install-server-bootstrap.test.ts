import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { persistServerSettings } from '../src/services/hooks/server-bootstrap.js';

const VALUES = { apiKey: 'cmem_testkey', projectId: 'proj-test' };

let tempDir: string;
let settingsPath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'claude-mem-server-bootstrap-'));
  settingsPath = join(tempDir, 'settings.json');
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('persistServerSettings: corrupt-document write refusal', () => {
  it('returns false and leaves bytes exact when file has corrupt JSON', () => {
    const corruptBytes = '{"CLAUDE_MEM_MODEL":"claude-opus-4-8"';
    writeFileSync(settingsPath, corruptBytes, 'utf-8');

    const result = persistServerSettings(settingsPath, VALUES);

    expect(result).toBe(false);
    expect(readFileSync(settingsPath, 'utf-8')).toBe(corruptBytes);
  });
});

describe('persistServerSettings: non-record write refusal', () => {
  it('returns false and leaves bytes exact for a root null', () => {
    const original = 'null';
    writeFileSync(settingsPath, original, 'utf-8');

    const result = persistServerSettings(settingsPath, VALUES);

    expect(result).toBe(false);
    expect(readFileSync(settingsPath, 'utf-8')).toBe(original);
  });

  it('returns false and leaves bytes exact for a root array', () => {
    const original = '["sentinel"]';
    writeFileSync(settingsPath, original, 'utf-8');

    const result = persistServerSettings(settingsPath, VALUES);

    expect(result).toBe(false);
    expect(readFileSync(settingsPath, 'utf-8')).toBe(original);
  });
});

describe('persistServerSettings: flat-record merge preservation', () => {
  it('writes API keys and preserves all unrelated root keys', () => {
    const original = {
      CLAUDE_MEM_RUNTIME: 'server',
      CLAUDE_MEM_MODEL: 'claude-opus-4-5',
      UNRELATED_KEY: 'keep-me',
    };
    writeFileSync(settingsPath, JSON.stringify(original, null, 2), 'utf-8');

    persistServerSettings(settingsPath, VALUES);

    const written = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(written.CLAUDE_MEM_SERVER_API_KEY).toBe('cmem_testkey');
    expect(written.CLAUDE_MEM_SERVER_PROJECT_ID).toBe('proj-test');
    expect(written.CLAUDE_MEM_RUNTIME).toBe('server');
    expect(written.CLAUDE_MEM_MODEL).toBe('claude-opus-4-5');
    expect(written.UNRELATED_KEY).toBe('keep-me');
  });
});

describe('persistServerSettings: nested-env merge preservation', () => {
  it('writes API keys into env block and preserves root peers', () => {
    const original = {
      theme: 'dark',
      permissions: { defaultMode: 'auto' },
      env: {
        CLAUDE_MEM_RUNTIME: 'server',
        EXISTING_VAR: 'keep-me',
      },
    };
    writeFileSync(settingsPath, JSON.stringify(original, null, 2), 'utf-8');

    persistServerSettings(settingsPath, VALUES);

    const written = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(written.theme).toBe('dark');
    expect(written.permissions).toEqual({ defaultMode: 'auto' });
    expect(written.env.CLAUDE_MEM_SERVER_API_KEY).toBe('cmem_testkey');
    expect(written.env.CLAUDE_MEM_SERVER_PROJECT_ID).toBe('proj-test');
    expect(written.env.CLAUDE_MEM_RUNTIME).toBe('server');
    expect(written.env.EXISTING_VAR).toBe('keep-me');
  });

  it('keeps API keys in nested env beside unrelated root Claude settings', () => {
    const original = {
      CLAUDE_CODE_MAX_OUTPUT_CHARS: '12000',
      env: { CLAUDE_MEM_RUNTIME: 'server' },
    };
    writeFileSync(settingsPath, JSON.stringify(original, null, 2), 'utf-8');

    persistServerSettings(settingsPath, VALUES);

    const written = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(written.CLAUDE_CODE_MAX_OUTPUT_CHARS).toBe('12000');
    expect(written.CLAUDE_MEM_SERVER_API_KEY).toBeUndefined();
    expect(written.env.CLAUDE_MEM_SERVER_API_KEY).toBe('cmem_testkey');
    expect(written.env.CLAUDE_MEM_SERVER_PROJECT_ID).toBe('proj-test');
  });
});

describe('persistServerSettings: env-array routing boundary', () => {
  it('treats {"env":["sentinel"]} as flat; array remains; API keys written at root', () => {
    const original = { env: ['sentinel'], CLAUDE_MEM_RUNTIME: 'server' };
    writeFileSync(settingsPath, JSON.stringify(original), 'utf-8');

    persistServerSettings(settingsPath, VALUES);

    const written = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(written.env).toEqual(['sentinel']);
    expect(written.CLAUDE_MEM_RUNTIME).toBe('server');
    expect(written.CLAUDE_MEM_SERVER_API_KEY).toBe('cmem_testkey');
    expect(written.CLAUDE_MEM_SERVER_PROJECT_ID).toBe('proj-test');
  });
});

describe('persistServerSettings: missing-file creation', () => {
  it('creates the parent directory, writes a flat document, and returns true', () => {
    const deepPath = join(tempDir, 'nested', 'subdir', 'settings.json');

    const result = persistServerSettings(deepPath, VALUES);

    expect(result).toBe(true);
    const written = JSON.parse(readFileSync(deepPath, 'utf-8'));
    expect(written.CLAUDE_MEM_SERVER_API_KEY).toBe('cmem_testkey');
    expect(written.CLAUDE_MEM_SERVER_PROJECT_ID).toBe('proj-test');
  });
});

describe('persistServerSettings: rotation retry marker', () => {
  it('retains the previous key id for a retry and clears it after successful rotation', () => {
    persistServerSettings(settingsPath, { ...VALUES, previousApiKeyId: 'old-key-id' });
    expect(JSON.parse(readFileSync(settingsPath, 'utf-8')).CLAUDE_MEM_SERVER_PREVIOUS_API_KEY_ID).toBe('old-key-id');

    persistServerSettings(settingsPath, VALUES);
    expect(JSON.parse(readFileSync(settingsPath, 'utf-8')).CLAUDE_MEM_SERVER_PREVIOUS_API_KEY_ID).toBeUndefined();
  });
});
