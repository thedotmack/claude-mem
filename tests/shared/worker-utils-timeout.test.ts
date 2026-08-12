import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
// Eagerly evaluate src/shared/paths.ts BEFORE any per-test env override:
// paths.ts freezes its DATA_DIR const at first evaluation, and without this
// import the dynamic `import('../../src/shared/worker-utils.js')` calls
// below can be the first to evaluate it — poisoning every later-loaded module
// in the same bun process (e.g. ProcessManager's PID_FILE in combined runs).
import '../../src/shared/paths.js';

describe('worker-utils API timeout resolution', () => {
  const originalTimeout = process.env.CLAUDE_MEM_API_TIMEOUT_MS;

  beforeEach(() => {
    delete process.env.CLAUDE_MEM_API_TIMEOUT_MS;
    mock.restore();
  });

  afterEach(() => {
    mock.restore();
    if (originalTimeout === undefined) delete process.env.CLAUDE_MEM_API_TIMEOUT_MS;
    else process.env.CLAUDE_MEM_API_TIMEOUT_MS = originalTimeout;
  });

  it('uses the env timeout when set', async () => {
    process.env.CLAUDE_MEM_API_TIMEOUT_MS = '1200';

    const workerUtils = await import('../../src/shared/worker-utils.js');
    workerUtils.clearPortCache();

    expect(workerUtils.getWorkerApiRequestTimeoutMs()).toBe(1200);
  });

  it('warns and falls back to default when env timeout is out of bounds', async () => {
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
      'Invalid timeout value, using default',
      expect.objectContaining({ value: '999999', min: 500, max: 300000 })
    );
  });
});
