import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { HOOK_TIMEOUTS } from '../../src/shared/hook-constants.js';
// Eagerly evaluate src/shared/paths.ts BEFORE any per-test env override:
// paths.ts freezes its DATA_DIR const at first evaluation, and without this
// import the dynamic `import('../../src/shared/worker-utils.js')` calls
// below can be the first to evaluate it — while the env var points at a
// soon-deleted per-test temp dir — poisoning every later-loaded module in the
// same bun process (e.g. ProcessManager's PID_FILE in combined runs). At this
// point the env var is the per-RUN temp dir pinned by the preload tripwire
// (tests/preload.ts), so paths.ts freezes on a stable, isolated dir that
// outlives this file. worker-utils itself is unaffected: it resolves its
// settings path at call time via SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR').
import '../../src/shared/paths.js';

describe('worker-utils API timeout resolution', () => {
  let tempDir: string;
  let settingsPath: string;
  const originalDataDir = process.env.CLAUDE_MEM_DATA_DIR;
  const originalTimeout = process.env.CLAUDE_MEM_API_TIMEOUT_MS;
  const originalSessionInitTimeout = process.env.CLAUDE_MEM_SESSION_INIT_TIMEOUT_MS;

  beforeEach(() => {
    tempDir = join(tmpdir(), `worker-timeout-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    settingsPath = join(tempDir, 'settings.json');
    process.env.CLAUDE_MEM_DATA_DIR = tempDir;
    delete process.env.CLAUDE_MEM_API_TIMEOUT_MS;
    delete process.env.CLAUDE_MEM_SESSION_INIT_TIMEOUT_MS;
    mock.restore();
  });

  afterEach(() => {
    mock.restore();
    if (originalDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
    else process.env.CLAUDE_MEM_DATA_DIR = originalDataDir;
    if (originalTimeout === undefined) delete process.env.CLAUDE_MEM_API_TIMEOUT_MS;
    else process.env.CLAUDE_MEM_API_TIMEOUT_MS = originalTimeout;
    if (originalSessionInitTimeout === undefined) delete process.env.CLAUDE_MEM_SESSION_INIT_TIMEOUT_MS;
    else process.env.CLAUDE_MEM_SESSION_INIT_TIMEOUT_MS = originalSessionInitTimeout;
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeSettings(timeout: string): void {
    const settings = SettingsDefaultsManager.getAllDefaults();
    settings.CLAUDE_MEM_DATA_DIR = tempDir;
    settings.CLAUDE_MEM_API_TIMEOUT_MS = timeout;
    settings.CLAUDE_MEM_SESSION_INIT_TIMEOUT_MS = '12000';
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

  it('uses the session-init settings timeout independently from the general API timeout (#3434)', async () => {
    const settings = SettingsDefaultsManager.getAllDefaults();
    settings.CLAUDE_MEM_DATA_DIR = tempDir;
    settings.CLAUDE_MEM_API_TIMEOUT_MS = '45000';
    settings.CLAUDE_MEM_SESSION_INIT_TIMEOUT_MS = '9000';
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');

    const workerUtils = await import('../../src/shared/worker-utils.js');
    workerUtils.clearPortCache();

    expect(workerUtils.getSessionInitRequestTimeoutMs()).toBe(9000);
  });

  it('prefers CLAUDE_MEM_SESSION_INIT_TIMEOUT_MS env over settings.json (#3434)', async () => {
    const settings = SettingsDefaultsManager.getAllDefaults();
    settings.CLAUDE_MEM_DATA_DIR = tempDir;
    settings.CLAUDE_MEM_SESSION_INIT_TIMEOUT_MS = '9000';
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
    process.env.CLAUDE_MEM_SESSION_INIT_TIMEOUT_MS = '1500';

    const workerUtils = await import('../../src/shared/worker-utils.js');
    workerUtils.clearPortCache();

    expect(workerUtils.getSessionInitRequestTimeoutMs()).toBe(1500);
  });

  it('does not scale the session-init default above the host hook cap on Windows (#3434)', async () => {
    const settings = SettingsDefaultsManager.getAllDefaults();
    settings.CLAUDE_MEM_DATA_DIR = tempDir;
    settings.CLAUDE_MEM_SESSION_INIT_TIMEOUT_MS = String(HOOK_TIMEOUTS.SESSION_INIT_REQUEST);
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');

    const workerUtils = await import('../../src/shared/worker-utils.js');
    workerUtils.clearPortCache();

    expect(workerUtils.getSessionInitRequestTimeoutMs()).toBe(HOOK_TIMEOUTS.SESSION_INIT_REQUEST);
    expect(workerUtils.getSessionInitRequestTimeoutMs()).toBeLessThan(HOOK_TIMEOUTS.SESSION_INIT_HOOK_CAP);
  });

  it('rejects session-init overrides that exceed the host hook cap (#3434)', async () => {
    writeSettings('45000');
    process.env.CLAUDE_MEM_SESSION_INIT_TIMEOUT_MS = String(HOOK_TIMEOUTS.SESSION_INIT_HOOK_CAP + 1000);

    const workerUtils = await import('../../src/shared/worker-utils.js');
    const loggerModule = await import('../../src/utils/logger.js');
    const warnSpy = spyOn(loggerModule.logger, 'warn').mockImplementation(() => {});

    workerUtils.clearPortCache();

    expect(workerUtils.getSessionInitRequestTimeoutMs()).toBe(HOOK_TIMEOUTS.SESSION_INIT_REQUEST);
    expect(warnSpy).toHaveBeenCalledWith(
      'SYSTEM',
      'Invalid CLAUDE_MEM_SESSION_INIT_TIMEOUT_MS, using default',
      expect.objectContaining({
        value: String(HOOK_TIMEOUTS.SESSION_INIT_HOOK_CAP + 1000),
        max: HOOK_TIMEOUTS.SESSION_INIT_REQUEST_MAX,
      })
    );
  });
});
