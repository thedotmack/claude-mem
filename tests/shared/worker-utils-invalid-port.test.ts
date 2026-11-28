import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { getDefaultWorkerPort } from '../../src/shared/install-port.js';
import { clearPortCache, getWorkerPort } from '../../src/shared/worker-utils.js';
import { logger } from '../../src/utils/logger.js';
// Evaluate paths.ts before any per-test env override, exactly as
// worker-utils-timeout.test.ts does: paths.ts freezes DATA_DIR at first
// evaluation and must not see the per-test temp dir.
import '../../src/shared/paths.js';

describe('worker-utils invalid worker port resolution', () => {
  let tempDir: string;
  const originalDataDir = process.env.CLAUDE_MEM_DATA_DIR;

  beforeEach(() => {
    tempDir = join(tmpdir(), `worker-port-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    process.env.CLAUDE_MEM_DATA_DIR = tempDir;
    mock.restore();
  });

  afterEach(() => {
    mock.restore();
    if (originalDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
    else process.env.CLAUDE_MEM_DATA_DIR = originalDataDir;
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeSettings(workerPort: unknown): void {
    const settings = SettingsDefaultsManager.getAllDefaults();
    settings.CLAUDE_MEM_DATA_DIR = tempDir;
    (settings as unknown as Record<string, unknown>).CLAUDE_MEM_WORKER_PORT = workerPort;
    writeFileSync(join(tempDir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf-8');
  }

  function expectedFallback(): number {
    return getDefaultWorkerPort(tempDir);
  }

  it('warns once and falls back to the derived default when the port is not a number', () => {
    writeSettings('abc');
    const warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});
    clearPortCache();

    expect(getWorkerPort()).toBe(expectedFallback());
    expect(warnSpy).toHaveBeenCalledWith(
      'SYSTEM',
      'Invalid CLAUDE_MEM_WORKER_PORT, using the default install port',
      expect.objectContaining({ value: 'abc', fallbackPort: expectedFallback() })
    );

    // The one-time warning does not fire again for the same process.
    clearPortCache();
    getWorkerPort();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects trailing garbage instead of parsing the numeric prefix', () => {
    writeSettings('37700abc');
    spyOn(logger, 'warn').mockImplementation(() => {});
    clearPortCache();

    expect(getWorkerPort()).toBe(expectedFallback());
  });

  it('falls back on out-of-range and non-numeric-typed values', () => {
    spyOn(logger, 'warn').mockImplementation(() => {});
    for (const invalid of [80, 70000, true]) {
      writeSettings(invalid);
      clearPortCache();
      expect(getWorkerPort()).toBe(expectedFallback());
    }
  });

  it('still resolves a valid string port, including the JSON number form', () => {
    writeSettings('39000');
    clearPortCache();
    expect(getWorkerPort()).toBe(39000);

    writeSettings(39001);
    clearPortCache();
    expect(getWorkerPort()).toBe(39001);
  });

  it('falls back on the readOnly diagnostic path instead of returning NaN', () => {
    writeSettings('not-a-port');
    spyOn(logger, 'warn').mockImplementation(() => {});
    clearPortCache();

    expect(getWorkerPort({ readOnly: true })).toBe(expectedFallback());
  });
});
