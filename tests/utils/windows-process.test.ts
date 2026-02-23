import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
  execFile: vi.fn(),
}));

import { execFileSync, execFile } from 'child_process';
import {
  getProcessCommandLine,
  findOrphanedClaudeProcesses,
  isProcessAlive,
} from '../../src/utils/windows-process.js';

const mockExecFileSync = vi.mocked(execFileSync);
const mockExecFile = vi.mocked(execFile);

// ─── Helpers ────────────────────────────────────────────────────────────────

type ExecFileCallback = (err: Error | null, result?: { stdout: string; stderr: string }) => void;

function mockExecFileAsyncSuccess(stdout: string): void {
  mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
    (callback as ExecFileCallback)(null, { stdout, stderr: '' });
    return {} as ReturnType<typeof execFile>;
  });
}

function mockExecFileAsyncError(err: Error): void {
  mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
    (callback as ExecFileCallback)(err);
    return {} as ReturnType<typeof execFile>;
  });
}

// ─── isProcessAlive ──────────────────────────────────────────────────────────

describe('isProcessAlive', () => {
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    killSpy = vi.spyOn(process, 'kill');
  });

  afterEach(() => {
    killSpy.mockRestore();
  });

  it('returns true when process.kill(pid, 0) succeeds', () => {
    killSpy.mockReturnValue(true);
    expect(isProcessAlive(1234)).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(1234, 0);
  });

  it('returns false when process.kill throws ESRCH', () => {
    killSpy.mockImplementation(() => { throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); });
    expect(isProcessAlive(9999)).toBe(false);
  });

  it('returns true when process.kill throws EPERM', () => {
    killSpy.mockImplementation(() => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); });
    expect(isProcessAlive(9999)).toBe(true);
  });

  it.each([0, -1, NaN])('returns false for invalid PID %s without calling kill', (pid) => {
    expect(isProcessAlive(pid)).toBe(false);
    expect(killSpy).not.toHaveBeenCalled();
  });
});

// ─── getProcessCommandLine ───────────────────────────────────────────────────

describe('getProcessCommandLine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns CommandLine string when PowerShell succeeds', () => {
    mockExecFileSync.mockReturnValue('"C:\\node.exe" --claude --haiku\r\n');
    expect(getProcessCommandLine(1234)).toBe('"C:\\node.exe" --claude --haiku');
  });

  it('trims Windows CRLF from output', () => {
    mockExecFileSync.mockReturnValue('node.exe --flag\r\n');
    expect(getProcessCommandLine(42)).toBe('node.exe --flag');
  });

  it('returns null when execFileSync throws', () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('Process not found'); });
    expect(getProcessCommandLine(99999)).toBeNull();
  });

  it('returns null when PowerShell is unavailable (ENOENT)', () => {
    mockExecFileSync.mockImplementation(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); });
    expect(getProcessCommandLine(1234)).toBeNull();
  });

  it('returns null for empty output', () => {
    mockExecFileSync.mockReturnValue('\r\n');
    expect(getProcessCommandLine(1234)).toBeNull();
  });

  it('returns null for whitespace-only output', () => {
    mockExecFileSync.mockReturnValue('   \r\n  ');
    expect(getProcessCommandLine(1234)).toBeNull();
  });

  it.each([0, -1, NaN, 1.5])('returns null for invalid PID %s without calling execFileSync', (pid) => {
    expect(getProcessCommandLine(pid)).toBeNull();
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('calls powershell.exe with -NoProfile and correct PID', () => {
    mockExecFileSync.mockReturnValue('node.exe\r\n');
    getProcessCommandLine(5678);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'powershell.exe',
      expect.arrayContaining(['-NoProfile', '-Command', expect.stringContaining('5678')]),
      expect.objectContaining({ encoding: 'utf-8', timeout: 10000 })
    );
  });
});

// ─── findOrphanedClaudeProcesses ─────────────────────────────────────────────

describe('findOrphanedClaudeProcesses', () => {
  let killSpy: ReturnType<typeof vi.spyOn>;

  function throwEsrch(): never {
    throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    killSpy = vi.spyOn(process, 'kill');
  });

  afterEach(() => {
    killSpy.mockRestore();
  });

  it('returns orphaned PIDs whose parent process is dead', async () => {
    mockExecFileAsyncSuccess([
      '"ProcessId","ParentProcessId"',
      '"1001","9999"',
      '"1002","1"',
    ].join('\n'));

    killSpy.mockImplementation((_pid: number) => {
      if (_pid === 9999) throwEsrch();
      return true;
    });

    expect(await findOrphanedClaudeProcesses()).toEqual([1001]);
  });

  it('returns empty array when all parents are alive', async () => {
    mockExecFileAsyncSuccess([
      '"ProcessId","ParentProcessId"',
      '"2001","1"',
      '"2002","2"',
    ].join('\n'));

    killSpy.mockReturnValue(true);

    expect(await findOrphanedClaudeProcesses()).toEqual([]);
  });

  it('returns empty array when only header line present', async () => {
    mockExecFileAsyncSuccess('"ProcessId","ParentProcessId"');
    expect(await findOrphanedClaudeProcesses()).toEqual([]);
  });

  it('returns empty array on PowerShell failure', async () => {
    mockExecFileAsyncError(new Error('PowerShell not found'));
    expect(await findOrphanedClaudeProcesses()).toEqual([]);
  });

  it('returns empty array for empty output', async () => {
    mockExecFileAsyncSuccess('');
    expect(await findOrphanedClaudeProcesses()).toEqual([]);
  });

  it('handles multiple orphaned processes', async () => {
    mockExecFileAsyncSuccess([
      '"ProcessId","ParentProcessId"',
      '"3001","8001"',
      '"3002","8002"',
      '"3003","1"',
    ].join('\n'));

    killSpy.mockImplementation((_pid: number) => {
      if (_pid === 8001 || _pid === 8002) throwEsrch();
      return true;
    });

    const result = await findOrphanedClaudeProcesses();
    expect(result).toContain(3001);
    expect(result).toContain(3002);
    expect(result).not.toContain(3003);
  });

  it('skips header line correctly', async () => {
    mockExecFileAsyncSuccess([
      '"ProcessId","ParentProcessId"',
      '"4001","9001"',
    ].join('\n'));

    killSpy.mockImplementation(() => throwEsrch());

    expect(await findOrphanedClaudeProcesses()).toEqual([4001]);
  });

  it('handles CSV with unquoted fields', async () => {
    mockExecFileAsyncSuccess('ProcessId,ParentProcessId\n5001,9001');

    killSpy.mockImplementation(() => throwEsrch());

    expect(await findOrphanedClaudeProcesses()).toEqual([5001]);
  });

  it('returns empty array for invalid PIDs in CSV', async () => {
    mockExecFileAsyncSuccess([
      '"ProcessId","ParentProcessId"',
      '"notanumber","alsonotanumber"',
    ].join('\n'));

    expect(await findOrphanedClaudeProcesses()).toEqual([]);
  });
});

// ─── Crash-recovery decision logic ───────────────────────────────────────────

describe('getProcessCommandLine - crash-recovery decisions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('cmdline containing "claude" signals a killable process', () => {
    mockExecFileSync.mockReturnValue('"C:\\claude.exe" --haiku --output-format stream-json\r\n');
    expect(getProcessCommandLine(1234)).toContain('claude');
  });

  it('cmdline without "claude" signals a safe (non-killable) process', () => {
    mockExecFileSync.mockReturnValue('"C:\\node.exe" --some-other-flag\r\n');
    expect(getProcessCommandLine(1234)).not.toContain('claude');
  });

  it('null cmdline means identity cannot be verified (skip kill)', () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('pid gone'); });
    expect(getProcessCommandLine(9999)).toBeNull();
  });
});
