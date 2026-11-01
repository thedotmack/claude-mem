import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
// See worker-utils-timeout.test.ts: eagerly freeze paths.ts on the stable
// per-run temp dir before any per-test env override poisons a later import.
import '../../src/shared/paths.js';

describe('getViewerBaseUrl', () => {
  let tempDir: string;
  let settingsPath: string;
  const originalDataDir = process.env.CLAUDE_MEM_DATA_DIR;
  const originalPublicUrl = process.env.CLAUDE_MEM_PUBLIC_URL;

  beforeEach(() => {
    tempDir = join(tmpdir(), `worker-viewer-url-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    settingsPath = join(tempDir, 'settings.json');
    process.env.CLAUDE_MEM_DATA_DIR = tempDir;
    delete process.env.CLAUDE_MEM_PUBLIC_URL;
    mock.restore();
  });

  afterEach(() => {
    mock.restore();
    if (originalDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
    else process.env.CLAUDE_MEM_DATA_DIR = originalDataDir;
    if (originalPublicUrl === undefined) delete process.env.CLAUDE_MEM_PUBLIC_URL;
    else process.env.CLAUDE_MEM_PUBLIC_URL = originalPublicUrl;
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeSettings(publicUrl: string): void {
    const settings = SettingsDefaultsManager.getAllDefaults();
    settings.CLAUDE_MEM_DATA_DIR = tempDir;
    settings.CLAUDE_MEM_PUBLIC_URL = publicUrl;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
  }

  it('prefers the CLAUDE_MEM_PUBLIC_URL env var over settings.json', async () => {
    writeSettings('https://from-settings.example');
    process.env.CLAUDE_MEM_PUBLIC_URL = 'https://from-env.example';

    const workerUtils = await import('../../src/shared/worker-utils.js');
    workerUtils.clearPortCache();

    expect(workerUtils.getViewerBaseUrl(37700)).toBe('https://from-env.example');
  });

  it('uses the settings.json value when no env override is present', async () => {
    writeSettings('https://37700.host.alice.example');

    const workerUtils = await import('../../src/shared/worker-utils.js');
    workerUtils.clearPortCache();

    expect(workerUtils.getViewerBaseUrl(37700)).toBe('https://37700.host.alice.example');
  });

  it('trims a trailing slash from the public URL', async () => {
    writeSettings('https://37700.host.alice.example/');

    const workerUtils = await import('../../src/shared/worker-utils.js');
    workerUtils.clearPortCache();

    expect(workerUtils.getViewerBaseUrl(37700)).toBe('https://37700.host.alice.example');
  });

  it('falls back to http://localhost:<port> when unset', async () => {
    writeSettings('');

    const workerUtils = await import('../../src/shared/worker-utils.js');
    workerUtils.clearPortCache();

    expect(workerUtils.getViewerBaseUrl(37742)).toBe('http://localhost:37742');
  });
});
