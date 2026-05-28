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

  it('uses no shell option for Unix which-bun lookup', () => {
    const unixCallMatch = source.match(/spawnSync\('which',\s*\['bun'\],\s*\{([^}]+)\}/)
    if (unixCallMatch) {
      expect(unixCallMatch[1]).not.toContain('shell');
    }
    expect(source).toContain("spawnSync('which', ['bun']");
  });
});

describe('bun-runner.js Codex hook stdin fallback', () => {
  it('feeds an empty JSON object for Codex hook invocations with missing stdin', () => {
    expect(source).toContain('function shouldUseEmptyJsonFallback(args)');
    expect(source).toContain("process.env.CLAUDE_MEM_CODEX_HOOK === '1'");
    expect(source).toContain("return args[1] === 'hook' && args[2] === 'codex'");
    expect(source).toContain("child.stdin.write('{}')");
  });

  it('keeps the empty stdin diagnostic for non-Codex invocations', () => {
    expect(source.indexOf('shouldUseEmptyJsonFallback(args)')).toBeLessThan(
      source.indexOf('[bun-runner] empty stdin payload received')
    );
  });
});
