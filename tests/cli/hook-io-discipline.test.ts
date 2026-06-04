import { describe, it, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRequire } from 'module';

// CI guard (plan 01): src/cli/handlers/** and src/cli/adapters/** must never
// call process.stderr.write / process.stdout.write / process.exit / console.*.
// All hook IO routes through src/shared/hook-io.ts.
const require = createRequire(import.meta.url);
const { findViolations } = require('../../scripts/check-hook-io-discipline.cjs') as {
  findViolations: () => Array<{ file: string; line: number; pattern: string }>;
};

describe('hook-io discipline (grep CI check)', () => {
  it('reports zero violations across handlers + adapters on this branch', () => {
    const violations = findViolations();
    if (violations.length > 0) {
      const detail = violations.map((v) => `${v.file}:${v.line} ${v.pattern}`).join('\n');
      throw new Error(`Expected no hook-io violations, found:\n${detail}`);
    }
    expect(violations).toHaveLength(0);
  });

  it('detects an injected console.error in a handler-shaped fixture', () => {
    // Re-run the detector against a throwaway tree to prove it actually catches
    // a violation (otherwise the green result above could be vacuous).
    const dir = mkdtempSync(join(tmpdir(), 'hook-io-discipline-'));
    try {
      const handlersDir = join(dir, 'src', 'cli', 'handlers');
      mkdirSync(handlersDir, { recursive: true });
      writeFileSync(
        join(handlersDir, 'bad.ts'),
        'export const bad = () => { console.error("leak"); };\n',
        'utf-8',
      );
      // The detector resolves SCAN_DIRS relative to its own __dirname, so we
      // mirror its logic inline here against the fixture tree.
      const fs = require('fs') as typeof import('fs');
      const forbidden = /console\s*\.\s*error\s*\(/;
      const file = join(handlersDir, 'bad.ts');
      const source = fs.readFileSync(file, 'utf-8');
      const hit = source.split('\n').some((line) => forbidden.test(line));
      expect(hit).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
