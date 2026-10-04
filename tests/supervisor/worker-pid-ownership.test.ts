import { describe, expect, it, mock } from 'bun:test';
import {
  captureProcessStartToken,
  verifyWorkerPidFileOwnership,
  type PidInfo,
  type WorkerCommandLineProbe,
} from '../../src/supervisor/process-registry.js';

// #4270: a worker PID record without a start token (written by a worker older
// than v12.3.8, or when the token capture failed) used to pass for whatever
// live process inherited the PID, so every later worker start was refused.
// On Linux it must now name worker-service.cjs. The probe stands in for /proc
// so the Linux rule runs on every platform; each record names this live test
// process, so the liveness half of the check always passes.

function tokenlessRecordForThisProcess(): PidInfo {
  return { pid: process.pid, port: 37777, startedAt: new Date().toISOString() };
}

function linuxProbe(readCommandLine: (pid: number) => string): WorkerCommandLineProbe {
  return { platform: 'linux', readCommandLine };
}

const WORKER_COMMAND_LINE = [
  '/home/dev/.bun/bin/bun',
  '/home/dev/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs',
  '--daemon',
  '',
].join('\0');

describe('verifyWorkerPidFileOwnership: token-less worker PID records (#4270)', () => {
  it('rejects a live PID whose command line runs another program (the PID was reused)', () => {
    const probe = linuxProbe(() => ['/usr/bin/sleep', '600', ''].join('\0'));
    expect(verifyWorkerPidFileOwnership(tokenlessRecordForThisProcess(), probe)).toBe(false);
  });

  it('accepts a live PID whose command line runs worker-service.cjs', () => {
    const probe = linuxProbe(() => WORKER_COMMAND_LINE);
    expect(verifyWorkerPidFileOwnership(tokenlessRecordForThisProcess(), probe)).toBe(true);
  });

  it('keeps trusting the live PID when its command line cannot be read', () => {
    const probe = linuxProbe(() => {
      throw new Error('EACCES: permission denied, open /proc/4242/cmdline');
    });
    expect(verifyWorkerPidFileOwnership(tokenlessRecordForThisProcess(), probe)).toBe(true);
  });

  it('leaves token-less records alone off Linux', () => {
    const readCommandLine = mock(() => '/usr/bin/sleep\0');
    expect(verifyWorkerPidFileOwnership(tokenlessRecordForThisProcess(), { platform: 'darwin', readCommandLine })).toBe(true);
    expect(readCommandLine).not.toHaveBeenCalled();
  });

  it('rejects a dead PID without reading a command line', () => {
    const readCommandLine = mock(() => WORKER_COMMAND_LINE);
    const deadRecord: PidInfo = { pid: 2147483647, port: 37777, startedAt: new Date().toISOString() };
    expect(verifyWorkerPidFileOwnership(deadRecord, linuxProbe(readCommandLine))).toBe(false);
    expect(readCommandLine).not.toHaveBeenCalled();
  });

  const tokenSupported = process.platform === 'linux' || process.platform === 'darwin';
  it.if(tokenSupported)('decides a tokened record by its start token alone', () => {
    const readCommandLine = mock(() => '/usr/bin/sleep\0');
    const tokenedRecord: PidInfo = {
      ...tokenlessRecordForThisProcess(),
      startToken: captureProcessStartToken(process.pid) ?? undefined,
    };
    expect(tokenedRecord.startToken).toBeDefined();
    expect(verifyWorkerPidFileOwnership(tokenedRecord, linuxProbe(readCommandLine))).toBe(true);
    expect(readCommandLine).not.toHaveBeenCalled();
  });
});
