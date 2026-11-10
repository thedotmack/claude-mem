import express from 'express';
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import { SettingsRoutes } from '../src/services/worker/http/routes/SettingsRoutes.js';
import { paths } from '../src/shared/paths.js';

describe('SettingsRoutes settings document writes', () => {
  let tempDir: string;
  let settingsPath: string;
  let originalSettingsPath: typeof paths.settings;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'claude-mem-settings-routes-'));
    settingsPath = join(tempDir, 'settings.json');
    originalSettingsPath = paths.settings;
    (paths as { settings: () => string }).settings = () => settingsPath;
  });

  afterEach(() => {
    (paths as { settings: () => string }).settings = originalSettingsPath;
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function startServer() {
    const app = express();
    app.use(express.json());
    new SettingsRoutes({} as any).setupRoutes(app);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not expose a TCP address');
    return { server, url: `http://127.0.0.1:${address.port}/api/settings` };
  }

  it('returns 400 when the request has no body', async () => {
    const { server, url } = await startServer();
    try {
      const response = await fetch(url, { method: 'POST' });
      expect(response.status).toBe(400);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('updates nested env settings in place and preserves the document shape', async () => {
    writeFileSync(settingsPath, JSON.stringify({
      theme: 'dark',
      CLAUDE_CODE_MAX_OUTPUT_CHARS: '12000',
      env: {
        CLAUDE_MEM_MODEL: 'old-model',
        KEEP_ME: 'yes',
      },
    }));
    const { server, url } = await startServer();

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          CLAUDE_MEM_MODEL: 'new-model',
          CLAUDE_CODE_PATH: '~/bin/claude',
        }),
      });

      expect(response.status).toBe(200);
      const written = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(written.theme).toBe('dark');
      expect(written.CLAUDE_CODE_MAX_OUTPUT_CHARS).toBe('12000');
      expect(written.env.CLAUDE_MEM_MODEL).toBe('new-model');
      expect(written.env.KEEP_ME).toBe('yes');
      expect(written.CLAUDE_MEM_MODEL).toBeUndefined();
      // CLAUDE_CODE_PATH is file/env only (#4166): an HTTP write never lands.
      expect(written.env.CLAUDE_CODE_PATH).toBeUndefined();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('keeps a stored secret when the viewer posts back its mask, and accepts a real replacement', async () => {
    const storedKey = 'or-secret-key-1234';
    writeFileSync(settingsPath, JSON.stringify({ theme: 'dark', env: { CLAUDE_MEM_OPENROUTER_API_KEY: storedKey } }));
    const { server, url } = await startServer();

    try {
      const masked = `${'*'.repeat(storedKey.length - 4)}${storedKey.slice(-4)}`;
      let response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ CLAUDE_MEM_OPENROUTER_API_KEY: masked }),
      });
      expect(response.status).toBe(200);
      expect(JSON.parse(readFileSync(settingsPath, 'utf-8')).env.CLAUDE_MEM_OPENROUTER_API_KEY).toBe(storedKey);

      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ CLAUDE_MEM_OPENROUTER_API_KEY: 'or-new-key-5678' }),
      });
      expect(response.status).toBe(200);
      expect(JSON.parse(readFileSync(settingsPath, 'utf-8')).env.CLAUDE_MEM_OPENROUTER_API_KEY).toBe('or-new-key-5678');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it.each([
    '{"CLAUDE_MEM_MODEL":"keep-me"',
    '["sentinel"]',
  ])('refuses invalid settings %s without touching its bytes (worker path never quarantines)', async (original) => {
    writeFileSync(settingsPath, original);
    const { server, url } = await startServer();

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ CLAUDE_MEM_MODEL: 'new-model' }),
      });

      expect(response.status).toBe(500);
      expect(readFileSync(settingsPath, 'utf-8')).toBe(original);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

describe('SettingsRoutes SessionStart block settings', () => {
  let tempDir: string;
  let settingsPath: string;
  let originalSettingsPath: typeof paths.settings;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'claude-mem-settings-routes-'));
    settingsPath = join(tempDir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({ theme: 'dark' }));
    originalSettingsPath = paths.settings;
    (paths as { settings: () => string }).settings = () => settingsPath;
  });

  afterEach(() => {
    (paths as { settings: () => string }).settings = originalSettingsPath;
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function postSettings(body: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    new SettingsRoutes({} as any).setupRoutes(app);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not expose a TCP address');
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/settings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return {
        status: response.status,
        json: await response.json() as { success: boolean; error?: string },
        written: JSON.parse(readFileSync(settingsPath, 'utf-8')),
      };
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }

  // #5392: the context renderer reads these three toggles, but the POST
  // whitelist dropped them, so the SessionStart block could not be turned
  // off through the API.
  it('persists the three SessionStart toggles the renderer reads', async () => {
    const { status, written } = await postSettings({
      CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT: 'false',
      CLAUDE_MEM_MEMORY_INSTRUCTIONS_ENABLED: 'false',
      CLAUDE_MEM_WELCOME_HINT_ENABLED: 'false',
    });

    expect(status).toBe(200);
    expect(written.CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT).toBe('false');
    expect(written.CLAUDE_MEM_MEMORY_INSTRUCTIONS_ENABLED).toBe('false');
    expect(written.CLAUDE_MEM_WELCOME_HINT_ENABLED).toBe('false');
  });

  it('rejects a non-boolean value for a SessionStart toggle', async () => {
    const { status, json } = await postSettings({ CLAUDE_MEM_WELCOME_HINT_ENABLED: 'yes' });

    expect(status).toBe(400);
    expect(json.error).toBe('CLAUDE_MEM_WELCOME_HINT_ENABLED must be "true" or "false"');
  });

  // Falsy values are posted values too: readers only honor the strings
  // "true"/"false", so saving 0 verbatim would report success while
  // leaving the toggle on.
  it('rejects falsy non-boolean values for a SessionStart toggle instead of saving them', async () => {
    for (const value of [0, '', null, false]) {
      const { status, json, written } = await postSettings({ CLAUDE_MEM_MEMORY_INSTRUCTIONS_ENABLED: value });

      expect(status).toBe(400);
      expect(json.error).toBe('CLAUDE_MEM_MEMORY_INSTRUCTIONS_ENABLED must be "true" or "false"');
      expect(written.CLAUDE_MEM_MEMORY_INSTRUCTIONS_ENABLED).toBeUndefined();
    }
  });

  // The renderer accepts 0 for both counts (parseContextCountValue allows
  // >= 0), so the API must accept it too: 0 observations / 0 sessions is
  // how the block is emptied.
  it('accepts 0 for the observation and session counts', async () => {
    const { status, written } = await postSettings({
      CLAUDE_MEM_CONTEXT_OBSERVATIONS: '0',
      CLAUDE_MEM_CONTEXT_SESSION_COUNT: '0',
    });

    expect(status).toBe(200);
    expect(written.CLAUDE_MEM_CONTEXT_OBSERVATIONS).toBe('0');
    expect(written.CLAUDE_MEM_CONTEXT_SESSION_COUNT).toBe('0');
  });

  it('still rejects counts outside the widened ranges', async () => {
    const observations = await postSettings({ CLAUDE_MEM_CONTEXT_OBSERVATIONS: '201' });
    expect(observations.status).toBe(400);
    expect(observations.json.error).toBe('CLAUDE_MEM_CONTEXT_OBSERVATIONS must be between 0 and 200');

    const sessions = await postSettings({ CLAUDE_MEM_CONTEXT_SESSION_COUNT: '51' });
    expect(sessions.status).toBe(400);
    expect(sessions.json.error).toBe('CLAUDE_MEM_CONTEXT_SESSION_COUNT must be between 0 and 50');

    const negative = await postSettings({ CLAUDE_MEM_CONTEXT_OBSERVATIONS: '-1' });
    expect(negative.status).toBe(400);

    const nonNumeric = await postSettings({ CLAUDE_MEM_CONTEXT_SESSION_COUNT: 'abc' });
    expect(nonNumeric.status).toBe(400);
  });
});
