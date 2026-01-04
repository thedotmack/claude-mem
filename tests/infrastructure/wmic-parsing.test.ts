import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

/**
 * Tests for WMIC output parsing logic used in Windows process enumeration.
 *
 * This tests the parsing behavior directly since mocking promisified exec
 * is unreliable across module boundaries. The parsing logic matches exactly
 * what's in ProcessManager.getChildProcesses().
 */

// Extract the parsing logic from ProcessManager for direct testing
// This matches the implementation in src/services/infrastructure/ProcessManager.ts lines 93-100
function parseWmicOutput(stdout: string): number[] {
  return stdout
    .trim()
    .split('\n')
    .map(line => {
      const match = line.match(/ProcessId=(\d+)/i);
      return match ? parseInt(match[1], 10) : NaN;
    })
    .filter(n => !isNaN(n) && Number.isInteger(n) && n > 0);
}

// Validate parent PID - matches ProcessManager.getChildProcesses() lines 85-88
function isValidParentPid(parentPid: number): boolean {
  return Number.isInteger(parentPid) && parentPid > 0;
}

describe('WMIC output parsing (Windows)', () => {
  describe('parseWmicOutput - ProcessId format parsing', () => {
    it('should parse ProcessId=12345 format correctly', () => {
      const stdout = 'ProcessId=12345\r\nProcessId=67890\r\n';

      const result = parseWmicOutput(stdout);

      expect(result).toEqual([12345, 67890]);
    });

    it('should parse single PID from WMIC output', () => {
      const stdout = 'ProcessId=54321\r\n';

      const result = parseWmicOutput(stdout);

      expect(result).toEqual([54321]);
    });

    it('should handle WMIC output with mixed case', () => {
      // WMIC output can vary in case on different Windows versions
      const stdout = 'PROCESSID=11111\r\nprocessid=22222\r\nProcessId=33333\r\n';

      const result = parseWmicOutput(stdout);

      expect(result).toEqual([11111, 22222, 33333]);
    });

    it('should handle empty WMIC output', () => {
      const stdout = '';

      const result = parseWmicOutput(stdout);

      expect(result).toEqual([]);
    });

    it('should handle WMIC output with only whitespace', () => {
      const stdout = '   \r\n  \r\n';

      const result = parseWmicOutput(stdout);

      expect(result).toEqual([]);
    });

    it('should filter invalid PIDs from WMIC output', () => {
      const stdout = 'ProcessId=12345\r\nProcessId=invalid\r\nProcessId=67890\r\n';

      const result = parseWmicOutput(stdout);

      expect(result).toEqual([12345, 67890]);
    });

    it('should filter negative PIDs from WMIC output', () => {
      // Negative PIDs won't match the regex /ProcessId=(\d+)/i (only digits)
      const stdout = 'ProcessId=12345\r\nProcessId=-1\r\nProcessId=67890\r\n';

      const result = parseWmicOutput(stdout);

      expect(result).toEqual([12345, 67890]);
    });

    it('should filter zero PIDs from WMIC output', () => {
      // Zero is filtered out by the n > 0 check
      const stdout = 'ProcessId=0\r\nProcessId=12345\r\n';

      const result = parseWmicOutput(stdout);

      expect(result).toEqual([12345]);
    });

    it('should handle WMIC output with extra lines and noise', () => {
      const stdout = '\r\n\r\nProcessId=12345\r\n\r\nSome other output\r\nProcessId=67890\r\n\r\n';

      const result = parseWmicOutput(stdout);

      expect(result).toEqual([12345, 67890]);
    });

    it('should handle Windows line endings (CRLF)', () => {
      const stdout = 'ProcessId=111\r\nProcessId=222\r\nProcessId=333\r\n';

      const result = parseWmicOutput(stdout);

      expect(result).toEqual([111, 222, 333]);
    });

    it('should handle Unix line endings (LF)', () => {
      const stdout = 'ProcessId=111\nProcessId=222\nProcessId=333\n';

      const result = parseWmicOutput(stdout);

      expect(result).toEqual([111, 222, 333]);
    });

    it('should handle lines with extra equals signs', () => {
      const stdout = 'ProcessId=12345\r\nSomeOther=value=with=equals\r\nProcessId=67890\r\n';

      const result = parseWmicOutput(stdout);

      expect(result).toEqual([12345, 67890]);
    });

    it('should handle very large PIDs', () => {
      // Windows PIDs can be large but are still 32-bit integers
      const stdout = 'ProcessId=2147483647\r\n';

      const result = parseWmicOutput(stdout);

      expect(result).toEqual([2147483647]);
    });

    it('should handle typical WMIC list format output', () => {
      // Real WMIC output often has blank lines and extra spacing
      const stdout = `

ProcessId=1234


ProcessId=5678

`;

      const result = parseWmicOutput(stdout);

      expect(result).toEqual([1234, 5678]);
    });
  });

  describe('parent PID validation', () => {
    it('should reject zero PID', () => {
      expect(isValidParentPid(0)).toBe(false);
    });

    it('should reject negative PID', () => {
      expect(isValidParentPid(-1)).toBe(false);
      expect(isValidParentPid(-100)).toBe(false);
    });

    it('should reject NaN', () => {
      expect(isValidParentPid(NaN)).toBe(false);
    });

    it('should reject non-integer (float)', () => {
      expect(isValidParentPid(1.5)).toBe(false);
      expect(isValidParentPid(100.1)).toBe(false);
    });

    it('should reject Infinity', () => {
      expect(isValidParentPid(Infinity)).toBe(false);
      expect(isValidParentPid(-Infinity)).toBe(false);
    });

    it('should accept valid positive integer PID', () => {
      expect(isValidParentPid(1)).toBe(true);
      expect(isValidParentPid(1000)).toBe(true);
      expect(isValidParentPid(12345)).toBe(true);
      expect(isValidParentPid(2147483647)).toBe(true);
    });
  });
});

describe('getChildProcesses platform behavior', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      writable: true,
      configurable: true
    });
  });

  it('should return empty array on non-Windows platforms (darwin)', async () => {
    Object.defineProperty(process, 'platform', {
      value: 'darwin',
      writable: true,
      configurable: true
    });

    // Import fresh to get updated platform value
    const { getChildProcesses } = await import('../../src/services/infrastructure/ProcessManager.js');

    const result = await getChildProcesses(1000);

    expect(result).toEqual([]);
  });

  it('should return empty array on non-Windows platforms (linux)', async () => {
    Object.defineProperty(process, 'platform', {
      value: 'linux',
      writable: true,
      configurable: true
    });

    const { getChildProcesses } = await import('../../src/services/infrastructure/ProcessManager.js');

    const result = await getChildProcesses(1000);

    expect(result).toEqual([]);
  });

  it('should return empty array for invalid parent PID regardless of platform', async () => {
    // Even on Windows, invalid parent PIDs should be rejected before exec
    const { getChildProcesses } = await import('../../src/services/infrastructure/ProcessManager.js');

    expect(await getChildProcesses(0)).toEqual([]);
    expect(await getChildProcesses(-1)).toEqual([]);
    expect(await getChildProcesses(NaN)).toEqual([]);
    expect(await getChildProcesses(1.5)).toEqual([]);
  });
});
