import { describe, it, expect } from 'bun:test';
import { formatBytes, formatDuration } from '../../../src/cli/utils/format';

describe('formatBytes', () => {
  it('should format 0 bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  it('should format bytes', () => {
    expect(formatBytes(512)).toBe('512 B');
  });

  it('should format kilobytes', () => {
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
  });

  it('should format megabytes', () => {
    expect(formatBytes(1024 * 1024)).toBe('1 MB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5 MB');
  });

  it('should format gigabytes', () => {
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1 GB');
  });
});

describe('formatDuration', () => {
  it('should format seconds only', () => {
    expect(formatDuration(45)).toBe('0m');
  });

  it('should format minutes', () => {
    expect(formatDuration(300)).toBe('5m');
  });

  it('should format hours and minutes', () => {
    expect(formatDuration(3660)).toBe('1h 1m');
  });

  it('should format days and hours', () => {
    expect(formatDuration(90000)).toBe('1d 1h');
  });
});
