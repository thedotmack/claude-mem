import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Regression tests for #1797: Worker spawn failure when Windows username
 * contains a space (e.g. C:\Users\John Doe\...).
 *
 * These tests inspect the source code for known-good patterns rather than
 * executing the scripts, because:
 * - The scripts are minified/bundled (not importable modules)
 * - Windows-specific code paths cannot be exercised on non-Windows CI
 * - The pattern follows the existing bun-runner.test.ts approach
 */

const WORKER_CLI_PATH = join(import.meta.dir, '..', 'plugin', 'scripts', 'worker-cli.js');
const WORKER_WRAPPER_PATH = join(import.meta.dir, '..', 'plugin', 'scripts', 'worker-wrapper.cjs');

const workerCliSource = readFileSync(WORKER_CLI_PATH, 'utf-8');
const workerWrapperSource = readFileSync(WORKER_WRAPPER_PATH, 'utf-8');

describe('worker-cli.js: PowerShell arg quoting (#1797 Bug 1)', () => {
  it('uses array syntax @() for -ArgumentList to prevent space-splitting', () => {
    // PowerShell's -ArgumentList 'path with spaces' splits at spaces.
    // The fix uses -ArgumentList @('path') which treats it as a single
    // array element. This prevents the worker script path from being
    // split when the username directory contains a space.
    expect(workerCliSource).toContain("-ArgumentList @('${a}')");
  });

  it('does not use bare string -ArgumentList that splits at spaces', () => {
    // The vulnerable pattern: -ArgumentList '${a}' (without @())
    // splits the path at spaces, causing PowerShell to interpret
    // "C:\Users\John" and "Doe\.bun\..." as separate arguments.
    const vulnerablePattern = /-ArgumentList\s+'[^@]/;
    expect(vulnerablePattern.test(workerCliSource)).toBe(false);
  });
});

describe('worker-wrapper.cjs: Bun spawn path quoting (#1797 Bug 2)', () => {
  it('uses windowsVerbatimArguments for Windows spawn', () => {
    // Without windowsVerbatimArguments, Node/Bun's child_process.spawn
    // re-tokenizes the args at spaces on Windows, truncating paths
    // like "C:\Users\John Doe\..." to "C:\Users\John".
    expect(workerWrapperSource).toContain('windowsVerbatimArguments:y');
  });

  it('wraps the worker-service path in quotes on Windows', () => {
    // The spawn args array uses a ternary: y?`"${l}"`:l
    // On Windows (y=true), the path is wrapped in double quotes so
    // windowsVerbatimArguments passes it through as a single token.
    expect(workerWrapperSource).toContain('y?`"${l}"`:l');
  });

  it('does not use bare unquoted path in spawn args', () => {
    // The vulnerable pattern: spawn(process.execPath,[l],{...})
    // without any Windows-specific quoting. The path would be
    // truncated at the first space.
    const vulnerablePattern = /spawn\(process\.execPath,\[l\],/;
    expect(vulnerablePattern.test(workerWrapperSource)).toBe(false);
  });
});
