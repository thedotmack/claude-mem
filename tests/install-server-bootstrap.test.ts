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
  it('leaves bytes exact and does not write when file has corrupt JSON', () => {
    const corruptBytes = '{"CLAUDE_MEM_MODEL":"claude-opus-4-8"';
    writeFileSync(settingsPath, corruptBytes, 'utf-8');

    persistServerSettings(settingsPath, VALUES);

    expect(readFileSync(settingsPath, 'utf-8')).toBe(corruptBytes);
  });
});

describe('persistServerSettings: non-record write refusal', () => {
  it('leaves bytes exact and does not write for a root null', () => {
    const original = 'null';
    writeFileSync(settingsPath, original, 'utf-8');

    persistServerSettings(settingsPath, VALUES);

    expect(readFileSync(settingsPath, 'utf-8')).toBe(original);
  });

  it('leaves bytes exact and does not write for a root array', () => {
    const original = '["sentinel"]';
    writeFileSync(settingsPath, original, 'utf-8');

    persistServerSettings(settingsPath, VALUES);

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
  it('creates the parent directory and writes a flat document when no file exists', () => {
    const deepPath = join(tempDir, 'nested', 'subdir', 'settings.json');

    persistServerSettings(deepPath, VALUES);

    const written = JSON.parse(readFileSync(deepPath, 'utf-8'));
    expect(written.CLAUDE_MEM_SERVER_API_KEY).toBe('cmem_testkey');
    expect(written.CLAUDE_MEM_SERVER_PROJECT_ID).toBe('proj-test');
  });
});
