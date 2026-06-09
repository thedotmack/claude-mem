import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';

describe('worker-utils API timeout resolution', () => {
  let tempDir: string;
  let settingsPath: string;
  const originalDataDir = process.env.CLAUDE_MEM_DATA_DIR;
  const originalTimeout = process.env.CLAUDE_MEM_API_TIMEOUT_MS;

  beforeEach(() => {
    tempDir = join(tmpdir(), `worker-timeout-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    settingsPath = join(tempDir, 'settings.json');
    process.env.CLAUDE_MEM_DATA_DIR = tempDir;
    delete process.env.CLAUDE_MEM_API_TIMEOUT_MS;
    mock.restore();
  });

  afterEach(() => {
    mock.restore();
    if (originalDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
    else process.env.CLAUDE_MEM_DATA_DIR = originalDataDir;
    if (originalTimeout === undefined) delete process.env.CLAUDE_MEM_API_TIMEOUT_MS;
    else process.env.CLAUDE_MEM_API_TIMEOUT_MS = originalTimeout;
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeSettings(timeout: string): void {
    const settings = SettingsDefaultsManager.getAllDefaults();
    settings.CLAUDE_MEM_DATA_DIR = tempDir;
    settings.CLAUDE_MEM_API_TIMEOUT_MS = timeout;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
  }

  it('uses settings.json timeout when no env override is present', async () => {
    writeSettings('45000');
    const workerUtils = await import('../../src/shared/worker-utils.js');
    workerUtils.clearPortCache();

    expect(workerUtils.getWorkerApiRequestTimeoutMs()).toBe(45000);
  });

  it('prefers env timeout over settings.json', async () => {
    writeSettings('45000');
    process.env.CLAUDE_MEM_API_TIMEOUT_MS = '1200';

    const workerUtils = await import('../../src/shared/worker-utils.js');
    workerUtils.clearPortCache();

    expect(workerUtils.getWorkerApiRequestTimeoutMs()).toBe(1200);
  });

  it('warns and falls back to default when env timeout is invalid', async () => {
    writeSettings('45000');
    process.env.CLAUDE_MEM_API_TIMEOUT_MS = '999999';

    const workerUtils = await import('../../src/shared/worker-utils.js');
    const loggerModule = await import('../../src/utils/logger.js');
    const warnSpy = spyOn(loggerModule.logger, 'warn').mockImplementation(() => {});

    workerUtils.clearPortCache();

    expect(workerUtils.getWorkerApiRequestTimeoutMs()).toBe(
      parseInt(SettingsDefaultsManager.getAllDefaults().CLAUDE_MEM_API_TIMEOUT_MS, 10)
    );
    expect(warnSpy).toHaveBeenCalledWith(
      'SYSTEM',
      'Invalid CLAUDE_MEM_API_TIMEOUT_MS, using default',
      expect.objectContaining({ value: '999999', min: 500, max: 300000 })
    );
  });
});
