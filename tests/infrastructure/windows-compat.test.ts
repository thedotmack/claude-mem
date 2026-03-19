import { describe, it, expect } from 'bun:test';
import { pathToFileURL } from 'url';
import { existsSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

/**
 * Tests for Windows compatibility fixes:
 * 1. isMainModule detection using pathToFileURL
 * 2. getDirname fallback when __dirname is stale (bundled builds)
 */

describe('isMainModule detection', () => {
  it('pathToFileURL produces correct href for Unix paths', () => {
    const unixPath = '/home/user/scripts/worker-service.cjs';
    const url = pathToFileURL(unixPath).href;
    expect(url).toBe('file:///home/user/scripts/worker-service.cjs');
  });

  it('pathToFileURL produces correct href for Windows paths', () => {
    // pathToFileURL normalizes Windows paths to file:///C:/...
    const windowsPath = 'C:/Users/test/.claude/plugins/scripts/worker-service.cjs';
    const url = pathToFileURL(windowsPath).href;
    expect(url).toStartWith('file:///');
    expect(url).toContain('worker-service.cjs');
  });

  it('pathToFileURL handles backslashes in Windows paths', () => {
    const windowsPath = 'C:\\Users\\test\\.claude\\plugins\\scripts\\worker-service.cjs';
    const url = pathToFileURL(windowsPath).href;
    expect(url).toStartWith('file:///');
    expect(url).toContain('worker-service.cjs');
    // Should not contain backslashes in the URL
    expect(url).not.toContain('\\');
  });

  it('endsWith check matches both .cjs and extensionless', () => {
    const cjsPath = '/path/to/worker-service.cjs';
    const plainPath = '/path/to/worker-service';
    expect(cjsPath.endsWith('worker-service.cjs')).toBe(true);
    expect(cjsPath.endsWith('worker-service')).toBe(false);
    expect(plainPath.endsWith('worker-service')).toBe(true);
    expect(plainPath.endsWith('worker-service.cjs')).toBe(false);
  });
});

describe('getDirname fallback', () => {
  it('existsSync returns false for non-existent bundled __dirname', () => {
    const stalePath = '/Users/alexnewman/conductor/workspaces/claude-mem/banjul/src/shared';
    expect(existsSync(stalePath)).toBe(false);
  });

  it('fileURLToPath resolves import.meta.url to actual file path', () => {
    const thisFile = fileURLToPath(import.meta.url);
    expect(existsSync(thisFile)).toBe(true);
    expect(thisFile).toContain('windows-compat.test.ts');
  });

  it('dirname of resolved import.meta.url is a valid directory', () => {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    expect(existsSync(thisDir)).toBe(true);
  });
});
