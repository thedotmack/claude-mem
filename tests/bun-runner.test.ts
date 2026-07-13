import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const BUN_RUNNER_PATH = join(import.meta.dir, '..', 'plugin', 'scripts', 'bun-runner.js');
const source = readFileSync(BUN_RUNNER_PATH, 'utf-8');

describe('bun-runner.js findBun: DEP0190 regression guard (#1503)', () => {
  it('does not use separate args array with shell:true (DEP0190 trigger pattern)', () => {
    const vulnerablePattern = /spawnSync\s*\(\s*(?:IS_WINDOWS\s*\?\s*['"]where['"]\s*:[^)]+|['"]where['"]),\s*\[[^\]]+\],\s*\{[^}]*shell\s*:\s*(?:true|IS_WINDOWS)/;
    expect(vulnerablePattern.test(source)).toBe(false);
  });

  it('uses a single string command for Windows where-bun lookup', () => {
    expect(source).toContain("spawnSync('where bun'");
  });

  it('hides the Windows where-bun probe window', () => {
    expect(source).toContain('windowsHide: true');
  });

  it('uses no shell option for Unix which-bun lookup', () => {
    const unixCallMatch = source.match(/spawnSync\('which',\s*\['bun'\],\s*\{([^}]+)\}/)
    if (unixCallMatch) {
      expect(unixCallMatch[1]).not.toContain('shell');
    }
    expect(source).toContain("spawnSync('which', ['bun']");
  });

  it('supports emitting SessionStart continue JSON without a shell wrapper', () => {
    expect(source).toContain("'--hook-continue-json'");
    expect(source).toContain("process.stdout.write('{\"continue\":true,\"suppressOutput\":true}\\n')");
  });

  it('suppresses child stdout when emitting SessionStart continue JSON', () => {
    expect(source).toContain("stdio: ['pipe', shouldEmitHookContinueJson ? 'ignore' : 'inherit', 'inherit']");
  });
});

describe('bun-runner.js hook watchdog: a wedged worker must not block the prompt', () => {
  it('arms a timeout for non-lifecycle (hook payload) invocations', () => {
    expect(source).toContain('watchdog = setTimeout(');
    expect(source).toContain('CLAUDE_MEM_HOOK_TIMEOUT_MS');
  });

  it('exempts lifecycle commands from the watchdog', () => {
    expect(source).toContain('if (!isLifecycle)');
  });

  it('clears the watchdog when the child closes', () => {
    expect(source).toContain('if (watchdog) clearTimeout(watchdog)');
  });

  it('tree-kills the child on Windows so no orphan worker survives', () => {
    expect(source).toContain('taskkill');
    expect(source).toContain("'/T'");
  });
});
