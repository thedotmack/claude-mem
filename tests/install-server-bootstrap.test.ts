import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { HOOK_API_KEY_SCOPES, persistServerSettings, readServerKeyRotationState } from '../src/services/hooks/server-bootstrap.js';
import { DEFAULT_LOCAL_API_KEY_SCOPES } from '../src/server/auth/sqlite-api-key-service.js';

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
});

// The installer writes this key into ~/.claude-mem/settings.json and every hook
// then authenticates with it against the server runtime's /v1 routes. Those
// routes gate reads on `memories:read` and writes on `memories:write`
// (ServerV1PostgresRoutes.ts), and hasRequiredScopes() requires exact scope
// membership with no alias/expansion. A bootstrapped key whose scopes do not
// include those two values 403s on every route — the server runtime is unusable
// for hooked clients even though the installer just reported success.
describe('HOOK_API_KEY_SCOPES satisfies the /v1 route scope requirements', () => {
  // Mirrors hasRequiredScopes() in src/server/middleware/postgres-auth.ts.
  const hasRequiredScopes = (grantedScopes: string[], requiredScopes: string[]): boolean =>
    requiredScopes.length === 0
    || grantedScopes.includes('*')
    || requiredScopes.every(scope => grantedScopes.includes(scope));

  it('grants memories:write, which every /v1 write route requires', () => {
    expect(hasRequiredScopes([...HOOK_API_KEY_SCOPES], ['memories:write'])).toBe(true);
  });

  it('grants memories:read, which every /v1 read route requires', () => {
    expect(hasRequiredScopes([...HOOK_API_KEY_SCOPES], ['memories:read'])).toBe(true);
  });

  it('covers the same route scopes as a default local (SQLite) key', () => {
    for (const scope of DEFAULT_LOCAL_API_KEY_SCOPES) {
      expect([...HOOK_API_KEY_SCOPES]).toContain(scope);
    }
  });
});
