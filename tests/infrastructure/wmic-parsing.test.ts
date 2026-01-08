import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

/**
 * Tests for PowerShell output parsing logic used in Windows process enumeration.
 *
 * This tests the parsing behavior directly since mocking promisified exec
 * is unreliable across module boundaries. The parsing logic matches exactly
 * what's in ProcessManager.getChildProcesses().
 */

// Extract the parsing logic from ProcessManager for direct testing
// This matches the implementation in src/services/infrastructure/ProcessManager.ts lines 95-100
function parsePowerShellOutput(stdout: string): number[] {
  return stdout
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && /^\d+$/.test(line))
    .map(line => parseInt(line, 10))
    .filter(pid => pid > 0);
}

// Validate parent PID - matches ProcessManager.getChildProcesses() lines 85-88
function isValidParentPid(parentPid: number): boolean {
  return Number.isInteger(parentPid) && parentPid > 0;
}

describe('PowerShell output parsing (Windows)', () => {
  describe('parsePowerShellOutput - simple number format parsing', () => {
    it('should parse simple number format correctly', () => {
      const stdout = '12345\r\n67890\r\n';

      const result = parsePowerShellOutput(stdout);

      expect(result).toEqual([12345, 67890]);
    });

    it('should parse single PID from PowerShell output', () => {
      const stdout = '54321\r\n';

      const result = parsePowerShellOutput(stdout);

      expect(result).toEqual([54321]);
    });

    it('should handle empty PowerShell output', () => {
      const stdout = '';

      const result = parsePowerShellOutput(stdout);

      expect(result).toEqual([]);
    });

    it('should handle PowerShell output with only whitespace', () => {
      const stdout = '   \r\n  \r\n';

      const result = parsePowerShellOutput(stdout);

      expect(result).toEqual([]);
    });

    it('should filter invalid PIDs from PowerShell output', () => {
      const stdout = '12345\r\ninvalid\r\n67890\r\n';

      const result = parsePowerShellOutput(stdout);

      expect(result).toEqual([12345, 67890]);
    });

    it('should filter negative PIDs from PowerShell output', () => {
      const stdout = '12345\r\n-1\r\n67890\r\n';

      const result = parsePowerShellOutput(stdout);

      expect(result).toEqual([12345, 67890]);
    });

    it('should filter zero PIDs from PowerShell output', () => {
      const stdout = '0\r\n12345\r\n';

      const result = parsePowerShellOutput(stdout);

      expect(result).toEqual([12345]);
    });

    it('should handle PowerShell output with extra lines and noise', () => {
      const stdout = '\r\n\r\n12345\r\n\r\nSome other output\r\n67890\r\n\r\n';

      const result = parsePowerShellOutput(stdout);

      expect(result).toEqual([12345, 67890]);
    });

    it('should handle Windows line endings (CRLF)', () => {
      const stdout = '111\r\n222\r\n333\r\n';

      const result = parsePowerShellOutput(stdout);

      expect(result).toEqual([111, 222, 333]);
    });

    it('should handle Unix line endings (LF)', () => {
      const stdout = '111\n222\n333\n';

      const result = parsePowerShellOutput(stdout);

      expect(result).toEqual([111, 222, 333]);
    });

    it('should handle very large PIDs', () => {
      // Windows PIDs can be large but are still 32-bit integers
      const stdout = '2147483647\r\n';

      const result = parsePowerShellOutput(stdout);

      expect(result).toEqual([2147483647]);
    });

    it('should handle typical PowerShell output with blank lines and extra spacing', () => {
      const stdout = `

1234


5678

`;

      const result = parsePowerShellOutput(stdout);

      expect(result).toEqual([1234, 5678]);
    });

    it('should filter lines with text and numbers mixed', () => {
      const stdout = '12345\r\nPID: 67890\r\n11111\r\n';

      const result = parsePowerShellOutput(stdout);

      expect(result).toEqual([12345, 11111]);
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
