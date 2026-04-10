import { describe, it, expect } from 'bun:test';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * Regression tests for issue #1342.
 *
 * Bundled plugin scripts use a shebang line (#!/usr/bin/env node or #!/usr/bin/env bun).
 * If those files are committed with Windows CRLF line endings, the shebang becomes
 * "#!/usr/bin/env node\r" which fails with:
 *   env: node\r: No such file or directory
 * on macOS and Linux, breaking the MCP server and all hook scripts.
 *
 * These tests guard against CRLF line endings being re-introduced into the
 * committed plugin scripts (e.g. by a Windows contributor without .gitattributes).
 */

const SCRIPTS_DIR = join(import.meta.dir, '..', 'plugin', 'scripts');

const SHEBANG_SCRIPTS = [
  'mcp-server.cjs',
  'worker-service.cjs',
  'context-generator.cjs',
  'bun-runner.js',
  'smart-install.js',
  'worker-cli.js',
];

describe('plugin/scripts line endings (#1342)', () => {
  for (const filename of SHEBANG_SCRIPTS) {
    const filePath = join(SCRIPTS_DIR, filename);

    it(`${filename} shebang line must not contain CRLF`, () => {
      expect(existsSync(filePath)).toBe(true);
      const content = readFileSync(filePath, 'binary');
      const firstLine = content.split('\n')[0];
      // CRLF would leave a trailing \r on the shebang line
      expect(firstLine.endsWith('\r')).toBe(false);
    });

    it(`${filename} must not contain any CRLF sequences`, () => {
      expect(existsSync(filePath)).toBe(true);
      const content = readFileSync(filePath, 'binary');
      expect(content.includes('\r\n')).toBe(false);
    });
  }
});
