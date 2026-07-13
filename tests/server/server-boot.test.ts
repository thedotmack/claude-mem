import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { loadServerMode } from '../../src/server/runtime/create-server-service.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { logger } from '../../src/utils/logger.js';

// #2443 — the server runtime must load an observation mode before it can
// accept jobs, and must FAIL FAST if no mode can be loaded.
describe('server boot: mode loading (#2443)', () => {
  const spies: ReturnType<typeof spyOn>[] = [];

  afterEach(() => {
    spies.splice(0).forEach(spy => spy.mockRestore());
  });

  it('loads the code mode and leaves a mode active', () => {
    spies.push(
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
    );

    expect(() => loadServerMode()).not.toThrow();
    // Validation: a mode is actually active after boot.
    expect(() => ModeManager.getInstance().getActiveMode()).not.toThrow();
    expect(ModeManager.getInstance().getActiveMode().observation_types.length).toBeGreaterThan(0);
  });

  it('fails fast (throws) when no mode can be loaded', () => {
    spies.push(
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
    );
    // Simulate a broken install: the bundled mode file is missing, so
    // ModeManager.loadMode('code') throws its critical error. The server boot
    // helper must propagate it rather than booting into a non-functional state.
    const loadSpy = spyOn(ModeManager.prototype, 'loadMode').mockImplementation(() => {
      throw new Error('Critical: code.json mode file missing');
    });
    spies.push(loadSpy);

    expect(() => loadServerMode()).toThrow(/code\.json mode file missing/);
  });
});
