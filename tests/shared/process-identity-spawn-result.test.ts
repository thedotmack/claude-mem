import { describe, it, expect } from 'bun:test';
import { startTokenFromSpawnResult } from '../../src/shared/process-identity.js';

/**
 * Guard for the start-token probe's stdout read.
 *
 * A probe the OS kills (a timeout is the common way) returns a result whose
 * `stdout` is absent. The old code called `result.stdout.trim()` guarded only
 * by `status === 0`, so on Bun a killed probe threw "TypeError: undefined is
 * not a function" instead of degrading to a null token — and on Windows that
 * removed the PID-reuse guard the token exists to provide (#4145).
 */
describe('startTokenFromSpawnResult', () => {
  it('returns null for a non-zero status', () => {
    expect(startTokenFromSpawnResult('ps-lstart', 123, { status: 1, stdout: 'ignored' })).toBeNull();
  });

  it('returns null (no throw) when a killed probe reports success with no stdout', () => {
    expect(startTokenFromSpawnResult('powershell-cim', 123, { status: 0, stdout: undefined })).toBeNull();
    expect(startTokenFromSpawnResult('powershell-cim', 123, { status: 0 })).toBeNull();
  });

  it('returns null when stdout is a non-string (Buffer with no encoding)', () => {
    expect(startTokenFromSpawnResult('ps-lstart', 123, { status: 0, stdout: Buffer.from('x') })).toBeNull();
  });

  it('returns null for a status-0 empty read (process already gone)', () => {
    expect(startTokenFromSpawnResult('powershell-cim', 123, { status: 0, stdout: '   \n' })).toBeNull();
  });

  it('returns the trimmed token for a successful read', () => {
    expect(
      startTokenFromSpawnResult('powershell-cim', 123, { status: 0, stdout: '20260921120000.123456\r\n' })
    ).toBe('20260921120000.123456');
  });
});
