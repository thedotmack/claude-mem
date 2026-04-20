import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Regression tests for bun-runner.js to prevent the re-introduction of
 * platform-specific issues that are difficult to catch in CI.
 *
 * These tests inspect the source code for known-bad patterns rather than
 * executing the script, because bun-runner.js is a top-level side-effecting
 * Node.js script (not an importable module) and the Windows-specific code
 * paths cannot be exercised on non-Windows CI runners.
 */

const BUN_RUNNER_PATH = join(import.meta.dir, '..', 'plugin', 'scripts', 'bun-runner.js');
const source = readFileSync(BUN_RUNNER_PATH, 'utf-8');

describe('bun-runner.js findBun: DEP0190 regression guard (#1503)', () => {
  it('does not use separate args array with shell:true (DEP0190 trigger pattern)', () => {
    // Node 22+ emits DEP0190 when spawnSync is called with a separate args array
    // AND shell:true, because the args are only concatenated (not escaped).
    // The vulnerable pattern looks like: spawnSync(cmd, ['bun'], { shell: true/IS_WINDOWS })
    // This test verifies the fix in findBun() has not been reverted.
    const vulnerablePattern = /spawnSync\s*\(\s*(?:IS_WINDOWS\s*\?\s*['"]where['"]\s*:[^)]+|['"]where['"]),\s*\[[^\]]+\],\s*\{[^}]*shell\s*:\s*(?:true|IS_WINDOWS)/;
    expect(vulnerablePattern.test(source)).toBe(false);
  });

  it('uses a single string command for Windows where-bun lookup', () => {
    // The safe pattern: pass a single combined string 'where bun' with shell:true
    // so no separate args array is involved. This is the fix for DEP0190.
    expect(source).toContain("spawnSync('where bun'");
  });

  it('uses no shell option for Unix which-bun lookup', () => {
    // On Unix, spawnSync('which', ['bun']) without shell:true is safe and avoids
    // the deprecation warning entirely.
    // Check that the unix path does NOT pass shell:true alongside the args array.
    // We look for the pattern: spawnSync('which', ['bun'], { ... }) — shell should be absent.
    const unixCallMatch = source.match(/spawnSync\('which',\s*\['bun'\],\s*\{([^}]+)\}/)
    if (unixCallMatch) {
      expect(unixCallMatch[1]).not.toContain('shell');
    }
    // If the pattern is not found as expected, that means the code changed shape —
    // either way we shouldn't have shell:true on the unix path
    expect(source).toContain("spawnSync('which', ['bun']");
  });
});
