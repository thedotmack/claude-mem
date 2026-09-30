import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const WRAPPER_PATH = join(import.meta.dir, '..', 'plugin', 'scripts', 'worker-wrapper.cjs');
const source = readFileSync(WRAPPER_PATH, 'utf-8');

const WINDOWS_HIDE = /windowsHide\s*:\s*(?:true|!0)/;

describe('plugin/scripts/worker-wrapper.cjs Windows hide (#3170)', () => {
  it('hides the inner worker spawn console window', () => {
    // Nested env:{...} braces break a naive \{[^}]*\} match; pin the spawn options
    // by the CLAUDE_MEM_MANAGED marker that only appears on this call.
    const spawnOptsMatch = source.match(
      /CLAUDE_MEM_MANAGED:"true"\},cwd:p\.default\.dirname\(l\)(?:,windowsHide:(?:true|!0))?\}/,
    );
    expect(spawnOptsMatch).not.toBeNull();
    expect(WINDOWS_HIDE.test(spawnOptsMatch![0])).toBe(true);
  });

  it('hides the Windows taskkill console window on shutdown', () => {
    const taskkillMatch = source.match(
      /execSync\)\s*\(\s*`taskkill[^`]*`\s*,\s*(\{[^}]*\})/,
    );
    expect(taskkillMatch).not.toBeNull();
    expect(WINDOWS_HIDE.test(taskkillMatch![1])).toBe(true);
  });
});
