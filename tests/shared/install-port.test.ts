import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getDefaultServerPort, getDefaultWorkerPort, getInstallPortOffset } from '../../src/shared/install-port.js';

describe('install port defaults', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-port-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('uses a stable data-directory hash when there is no uid', () => {
    const options = { platform: 'win32' as const, uid: null };
    const first = getInstallPortOffset(dataDir, options);

    expect(first).toBe(getInstallPortOffset(dataDir, options));
    expect(getDefaultWorkerPort(dataDir, options)).toBeGreaterThanOrEqual(37700);
    expect(getDefaultWorkerPort(dataDir, options)).toBeLessThan(37800);
    expect(getDefaultServerPort(dataDir, options)).toBe(37877 + first);
  });


  it('normalizes Windows data-directory casing before hashing', () => {
    const options = { platform: 'win32' as const, uid: null };

    expect(getInstallPortOffset('C:\\Profiles\\Claude', options))
      .toBe(getInstallPortOffset('c:\\profiles\\claude', options));
  });

  it('uses fixed Windows path hashes shared with the Hermes provider', () => {
    const options = { platform: 'win32' as const, uid: null };

    expect(getDefaultWorkerPort('C:\\Profiles\\Claude', options)).toBe(37746);
    expect(getDefaultWorkerPort('D:\\AgentData\\CMEM', options)).toBe(37791);
  });

  it('preserves the old Windows port offset when 37777 is already saved', () => {
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ CLAUDE_MEM_WORKER_PORT: '37777' }));

    expect(getDefaultWorkerPort(dataDir, { platform: 'win32', uid: null })).toBe(37777);
    expect(getDefaultServerPort(dataDir, { platform: 'win32', uid: null })).toBe(37954);
  });

  it('preserves the legacy Windows server URL after the worker port changes', () => {
    const options = { platform: 'win32' as const, uid: null };
    const expectedWorkerPort = getDefaultWorkerPort(dataDir, options);
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({
      CLAUDE_MEM_WORKER_PORT: '39999',
      CLAUDE_MEM_SERVER_URL: 'http://127.0.0.1:37954',
    }));

    expect(getDefaultWorkerPort(dataDir, options)).toBe(expectedWorkerPort);
    expect(getDefaultServerPort(dataDir, options)).toBe(37954);
  });
});
