import { describe, it, expect } from 'bun:test';
import { paths, getWorkerPort } from '../../../src/cli/utils/paths';
import { homedir } from 'os';
import { join } from 'path';

describe('paths', () => {
  it('should have correct home directory', () => {
    expect(paths.home).toBe(homedir());
  });

  it('should have correct Claude directory', () => {
    expect(paths.claudeDir).toBe(join(homedir(), '.claude'));
  });

  it('should have correct Claude-Mem directory', () => {
    expect(paths.claudeMemDir).toBe(join(homedir(), '.claude-mem'));
  });

  it('should have correct database path', () => {
    expect(paths.database).toBe(join(homedir(), '.claude-mem', 'claude-mem.db'));
  });

  it('should have correct logs directory', () => {
    expect(paths.logsDir).toBe(join(homedir(), '.claude-mem', 'logs'));
  });
});

describe('getWorkerPort', () => {
  it('should return default port when no settings file', () => {
    const port = getWorkerPort();
    expect(port).toBe(37777);
  });

  it('should return number', () => {
    const port = getWorkerPort();
    expect(typeof port).toBe('number');
  });
});
