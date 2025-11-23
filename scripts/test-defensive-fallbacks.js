#!/usr/bin/env node
/**
 * Test to find defensive fallback ("or" logic validation test for silentDebug) patterns that hide silent failures
 * Searches for: || '', || null, || undefined, || {}, || [], etc.
 */

import { execSync } from 'child_process';

const PATTERNS = [
  { pattern: "\\|\\| ''", description: "Empty string fallback" },
  { pattern: '\\|\\| ""', description: "Empty string fallback (double quotes)" },
  { pattern: "\\|\\| null", description: "Null fallback" },
  { pattern: "\\|\\| undefined", description: "Undefined fallback" },
  { pattern: "\\|\\| \\{\\}", description: "Empty object fallback" },
  { pattern: "\\|\\| \\[\\]", description: "Empty array fallback" },
  { pattern: "\\|\\| 0", description: "Zero fallback" },
  { pattern: "\\|\\| false", description: "False fallback" },
];

const EXCLUDE_PATHS = [
  'node_modules',
  'plugin',
  '.git',
  'dist',
  'build',
];

console.log('🔍 Searching for defensive fallback patterns...\n');

let totalFindings = 0;

for (const { pattern, description } of PATTERNS) {
  try {
    const excludeArgs = EXCLUDE_PATHS.map(p => `--exclude-dir=${p}`).join(' ');
    const cmd = `grep -rn -E "${pattern}" src/ ${excludeArgs} || true`;
    const output = execSync(cmd, { encoding: 'utf-8' }).trim();

    if (output) {
      const lines = output.split('\n').filter(Boolean);
      console.log(`❌ Found ${lines.length} instances of ${description}:`);
      lines.forEach(line => console.log(`   ${line}`));
      console.log('');
      totalFindings += lines.length;
    }
  } catch (error) {
    // Ignore grep errors
  }
}

if (totalFindings === 0) {
  console.log('✅ No defensive fallback patterns found!');
  process.exit(0);
} else {
  console.log(`\n❌ Total findings: ${totalFindings}`);
  console.log('\n💡 These patterns may be hiding silent failures. Consider:');
  console.log('   1. Explicit error handling instead of fallbacks');
  console.log('   2. Fail-fast with clear error messages');
  console.log('   3. Remove if the value is guaranteed to exist');
  process.exit(1);
}
