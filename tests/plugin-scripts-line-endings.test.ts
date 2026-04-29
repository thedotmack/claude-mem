import { describe, it, expect } from 'bun:test';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const SCRIPTS_DIR = join(import.meta.dir, '..', 'plugin', 'scripts');

const SHEBANG_SCRIPTS = [
  'mcp-server.cjs',
  'worker-service.cjs',
  'context-generator.cjs',
  'bun-runner.js',
  'worker-cli.js',
];

describe('plugin/scripts line endings (#1342)', () => {
  for (const filename of SHEBANG_SCRIPTS) {
    const filePath = join(SCRIPTS_DIR, filename);

    it(`${filename} shebang line must not contain CRLF`, () => {
      expect(existsSync(filePath)).toBe(true);
      const content = readFileSync(filePath, 'binary');
      const firstLine = content.split('\n')[0];
      expect(firstLine.endsWith('\r')).toBe(false);
    });

    it(`${filename} must not contain any CRLF sequences`, () => {
      expect(existsSync(filePath)).toBe(true);
      const content = readFileSync(filePath, 'binary');
      expect(content.includes('\r\n')).toBe(false);
    });
  }
});
