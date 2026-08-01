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

  it('updates nested env settings in place and preserves the document shape', async () => {
    writeFileSync(settingsPath, JSON.stringify({
      theme: 'dark',
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
      expect(written.env.CLAUDE_MEM_MODEL).toBe('new-model');
      expect(written.env.KEEP_ME).toBe('yes');
      expect(written.CLAUDE_MEM_MODEL).toBeUndefined();
      expect(written.env.CLAUDE_CODE_PATH).toBe(join(homedir(), 'bin', 'claude'));
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('keeps an object-valued flat env setting at the root', async () => {
    const envValue = { enabled: true, sources: ['local'] };
    writeFileSync(settingsPath, JSON.stringify({
      env: envValue,
      CLAUDE_MEM_MODEL: 'old-model',
    }));
    const { server, url } = await startServer();

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ CLAUDE_MEM_MODEL: 'new-model' }),
      });

      expect(response.status).toBe(200);
      const written = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(written.env).toEqual(envValue);
      expect(written.CLAUDE_MEM_MODEL).toBe('new-model');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('refuses a root array without replacing its bytes', async () => {
    const original = '["sentinel"]';
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
