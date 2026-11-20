import { describe, it, expect } from 'bun:test';
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

});
