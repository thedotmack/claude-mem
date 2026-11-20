import { test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { resolveTreeSitterBinPath } from '../../../src/services/smart-file-read/parser.js';

let available = false;
try {
  execFileSync(resolveTreeSitterBinPath(), ['--version'], { stdio: 'ignore', timeout: 10000 });
  available = true;
} catch {
  if (process.env.CI) throw new Error('CI requires a runnable tree-sitter binary for native smart-read regressions.');
}
// Optional runtime installs may lack the native binary locally. CI must execute
// these regressions, so a missing prerequisite fails explicitly there.
export const nativeTest = available ? test : test.skip;
