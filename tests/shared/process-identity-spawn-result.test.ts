import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { startTokenFromSpawnResult } from '../../src/shared/process-identity.js';
import { logger } from '../../src/utils/logger.js';

/**
 * Guard for the start-token probe's stdout read.
 *
 * A probe the OS kills (a timeout is the common way) returns a result whose
 * `stdout` is absent. The old code called `result.stdout.trim()` guarded only
 * by `status === 0`, so on Bun a killed probe threw "TypeError: undefined is
 * not a function" instead of degrading to a null token — and on Windows that
 * removed the PID-reuse guard the token exists to provide (#4145).
 *
 * The logging contract matters as much as the return value: a status-0 read
 * with no usable stdout is a silent loss of reuse protection, so it warns; a
 * status-0 empty read is the normal "process is gone" answer, so it stays
 * quiet. Both are asserted so a later change cannot drop the diagnostic or add
 * noise for ordinary process exit.
 */
describe('startTokenFromSpawnResult', () => {
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('returns null for a non-zero status, without warning', () => {
    expect(startTokenFromSpawnResult('ps-lstart', 123, { status: 1, stdout: 'ignored' })).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns null and warns when a killed probe reports success with no stdout', () => {
    expect(startTokenFromSpawnResult('powershell-cim', 123, { status: 0, stdout: undefined })).toBeNull();
    expect(startTokenFromSpawnResult('powershell-cim', 123, { status: 0 })).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it('returns null and warns when stdout is a non-string (Buffer with no encoding)', () => {
    expect(startTokenFromSpawnResult('ps-lstart', 123, { status: 0, stdout: Buffer.from('x') })).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('returns null WITHOUT warning for a status-0 empty read (process already gone)', () => {
    expect(startTokenFromSpawnResult('powershell-cim', 123, { status: 0, stdout: '   \n' })).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns the trimmed token for a successful read, without warning', () => {
    expect(
      startTokenFromSpawnResult('powershell-cim', 123, { status: 0, stdout: '20260921120000.123456\r\n' })
    ).toBe('20260921120000.123456');
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
