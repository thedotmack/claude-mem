import { describe, it, expect, vi } from 'vitest';
import { existsSync } from 'fs';
import { spawnSync } from 'child_process';

// Mock the dependencies
vi.mock('fs', () => ({
  existsSync: vi.fn()
}));

vi.mock('child_process', () => ({
  spawnSync: vi.fn()
}));

// Import after mocking
import { getBunPath, isBunAvailable, getBunPathOrThrow } from '../src/utils/bun-path';

describe('bun-path utility', () => {
  it('should return "bun" when available in PATH', () => {
    // Mock successful bun --version check
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: Buffer.from('1.0.0'),
      stderr: Buffer.from(''),
      pid: 1234,
      output: [],
      signal: null
    } as any);

    const result = getBunPath();
    expect(result).toBe('bun');
    expect(spawnSync).toHaveBeenCalledWith('bun', ['--version'], expect.any(Object));
  });

  it('should check common installation paths when not in PATH', () => {
    // Mock failed PATH check
    vi.mocked(spawnSync).mockReturnValue({
      status: 1,
      stdout: Buffer.from(''),
      stderr: Buffer.from(''),
      pid: 1234,
      output: [],
      signal: null
    } as any);

    // Mock existsSync to return true for ~/.bun/bin/bun
    vi.mocked(existsSync).mockImplementation((path: any) => {
      return path.includes('.bun/bin/bun');
    });

    const result = getBunPath();
    expect(result).toContain('.bun/bin/bun');
  });

  it('should return null when bun is not found anywhere', () => {
    // Mock failed PATH check
    vi.mocked(spawnSync).mockReturnValue({
      status: 1,
      stdout: Buffer.from(''),
      stderr: Buffer.from(''),
      pid: 1234,
      output: [],
      signal: null
    } as any);

    // Mock existsSync to always return false
    vi.mocked(existsSync).mockReturnValue(false);

    const result = getBunPath();
    expect(result).toBeNull();
  });

  it('should return true for isBunAvailable when bun is found', () => {
    // Mock successful bun check
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: Buffer.from('1.0.0'),
      stderr: Buffer.from(''),
      pid: 1234,
      output: [],
      signal: null
    } as any);

    const result = isBunAvailable();
    expect(result).toBe(true);
  });

  it('should throw error in getBunPathOrThrow when bun not found', () => {
    // Mock failed bun check
    vi.mocked(spawnSync).mockReturnValue({
      status: 1,
      stdout: Buffer.from(''),
      stderr: Buffer.from(''),
      pid: 1234,
      output: [],
      signal: null
    } as any);
    vi.mocked(existsSync).mockReturnValue(false);

    expect(() => getBunPathOrThrow()).toThrow('Bun is required');
  });
});
