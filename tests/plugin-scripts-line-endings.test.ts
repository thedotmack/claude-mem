import { describe, it, expect } from 'bun:test';
import { execFileSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const REPO_ROOT = join(import.meta.dir, '..');
const HAND_WRITTEN_SCRIPTS = ['bun-runner.js'];

describe('plugin/scripts line endings (#1342)', () => {
  for (const filename of HAND_WRITTEN_SCRIPTS) {
    const relativePath = `plugin/scripts/${filename}`;
    const filePath = join(REPO_ROOT, relativePath);

    it(`${filename} must not contain any CRLF sequences`, () => {
      expect(existsSync(filePath)).toBe(true);
      expect(readFileSync(filePath, 'binary')).not.toContain('\r\n');
      expect(execFileSync('git', ['check-attr', 'eol', '--', relativePath], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      }).trim()).toBe(`${relativePath}: eol: lf`);
    });
  }
});
