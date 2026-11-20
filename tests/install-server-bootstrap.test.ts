import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { HOOK_API_KEY_SCOPES, persistServerSettings, readServerKeyRotationState } from '../src/services/hooks/server-bootstrap.js';

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

describe('readServerKeyRotationState: only the retry marker resumes a rotation', () => {
  it('treats settings without a marker as an ordinary rotation, never a pending revocation of the current key', () => {
    persistServerSettings(settingsPath, VALUES);
    const state = readServerKeyRotationState(JSON.parse(readFileSync(settingsPath, 'utf-8')));
    expect(state).toEqual({ pendingRevocationKeyId: null, currentApiKey: 'cmem_testkey', currentProjectId: 'proj-test' });
  });

  it('resumes the pending revocation a failed rotation left behind', () => {
    persistServerSettings(settingsPath, { ...VALUES, previousApiKeyId: 'old-key-id' });
    const state = readServerKeyRotationState(JSON.parse(readFileSync(settingsPath, 'utf-8')));
    expect(state.pendingRevocationKeyId).toBe('old-key-id');
    expect(state.currentApiKey).toBe('cmem_testkey');
  });

  it('reads pre-rename CLAUDE_MEM_SERVER_BETA_* credentials and ignores empty values', () => {
    expect(readServerKeyRotationState({
      CLAUDE_MEM_SERVER_BETA_API_KEY: 'cmem_beta',
      CLAUDE_MEM_SERVER_BETA_PROJECT_ID: 'proj-beta',
      CLAUDE_MEM_SERVER_PREVIOUS_API_KEY_ID: '',
    })).toEqual({ pendingRevocationKeyId: null, currentApiKey: 'cmem_beta', currentProjectId: 'proj-beta' });
    expect(readServerKeyRotationState(null)).toEqual({ pendingRevocationKeyId: null, currentApiKey: null, currentProjectId: null });
  });

  it('falls back to the legacy key when the canonical one is blank, as hooks do (runtime-selector)', () => {
    // A settings file seeded from SettingsDefaultsManager carries the canonical keys as "".
    expect(readServerKeyRotationState({
      CLAUDE_MEM_SERVER_API_KEY: '',
      CLAUDE_MEM_SERVER_PROJECT_ID: '  ',
      CLAUDE_MEM_SERVER_BETA_API_KEY: ' cmem_legacy ',
      CLAUDE_MEM_SERVER_BETA_PROJECT_ID: 'proj-legacy',
    })).toEqual({ pendingRevocationKeyId: null, currentApiKey: 'cmem_legacy', currentProjectId: 'proj-legacy' });
  });
});

describe('HOOK_API_KEY_SCOPES satisfies the /v1 route scope requirements', () => {
  it('grants the required read and write scopes', () => {
    expect(HOOK_API_KEY_SCOPES).toEqual(expect.arrayContaining(['memories:read', 'memories:write']));
  });
});
