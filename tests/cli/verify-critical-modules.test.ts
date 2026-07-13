import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  ensureTreeSitterCliBinary,
  treeSitterCliBinaryPath,
  verifyCriticalModules,
} from '../../src/npx-cli/install/setup-runtime';

/**
 * Write a fake installed package into <targetDir>/node_modules/<name>.
 * `exports` is the package.json `exports` map; any referenced stub files are created.
 */
function writeFakePackage(
  targetDir: string,
  name: string,
  exportsMap: Record<string, string>,
): void {
  const pkgDir = join(targetDir, 'node_modules', ...name.split('/'));
  mkdirSync(pkgDir, { recursive: true });

  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name, version: '0.0.0', type: 'module', exports: exportsMap }),
  );

  // Materialize every stub file the exports map points at so resolution succeeds.
  for (const target of Object.values(exportsMap)) {
    const rel = target.replace(/^\.\//, '');
    const stubPath = join(pkgDir, ...rel.split('/'));
    mkdirSync(join(stubPath, '..'), { recursive: true });
    writeFileSync(stubPath, 'export default {};\n');
  }
}

/**
 * Write a fake bin-only installed package into <targetDir>/node_modules/<name>.
 * Mirrors `tree-sitter-cli`: package.json has ONLY a `bin` field — no
 * `main`/`module`/`exports` and no index.js — so its bare name is unresolvable
 * by Node's rules even though the package is genuinely installed. The bin stub
 * is materialized so the manifest is internally consistent.
 */
function writeFakeBinOnlyPackage(targetDir: string, name: string, binName: string): void {
  const pkgDir = join(targetDir, 'node_modules', ...name.split('/'));
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name, version: '0.0.0', bin: { [binName]: './cli.js' } }),
  );
  writeFileSync(join(pkgDir, 'cli.js'), '#!/usr/bin/env node\n');
}

function writeRootPackage(targetDir: string, dependencies: Record<string, string>): void {
  writeFileSync(
    join(targetDir, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '0.0.0', dependencies }),
  );
}

describe('verifyCriticalModules', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `verify-critical-modules-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(join(tempDir, 'node_modules'), { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('throws naming zod/v3 when zod is missing the ./v3 subpath export', () => {
    writeRootPackage(tempDir, { zod: '^4.0.0' });
    // zod is present and its root resolves, but ./v3 is absent from exports.
    writeFakePackage(tempDir, 'zod', {
      '.': './index.js',
      './v4': './v4/index.js',
      './v4-mini': './v4-mini/index.js',
    });

    expect(() => verifyCriticalModules(tempDir)).toThrow(/zod\/v3/);
  });

  it('passes when zod exposes all required subpath exports', () => {
    writeRootPackage(tempDir, { zod: '^4.0.0' });
    writeFakePackage(tempDir, 'zod', {
      '.': './index.js',
      './v3': './v3/index.js',
      './v4': './v4/index.js',
      './v4-mini': './v4-mini/index.js',
    });

    expect(() => verifyCriticalModules(tempDir)).not.toThrow();
  });

  it('does NOT false-fail on a bin-only dependency (e.g. tree-sitter-cli)', () => {
    // faux-cli is bin-only: bare-name resolution fails, but it IS installed.
    // The package.json fallback must recognize it as present (#2730 regression).
    writeRootPackage(tempDir, { zod: '^4.0.0', 'faux-cli': '^1.0.0' });
    writeFakePackage(tempDir, 'zod', {
      '.': './index.js',
      './v3': './v3/index.js',
      './v4': './v4/index.js',
      './v4-mini': './v4-mini/index.js',
    });
    writeFakeBinOnlyPackage(tempDir, 'faux-cli', 'faux');

    expect(() => verifyCriticalModules(tempDir)).not.toThrow();
  });

  it('rejects tree-sitter-cli when its downloaded executable is missing', () => {
    writeRootPackage(tempDir, { 'tree-sitter-cli': '^0.26.0' });
    writeFakeBinOnlyPackage(tempDir, 'tree-sitter-cli', 'tree-sitter');

    expect(() => verifyCriticalModules(tempDir)).toThrow(/tree-sitter-cli executable/);
  });

  it('rejects tree-sitter-cli when its downloaded file is not executable', () => {
    if (process.platform === 'win32') return;

    writeRootPackage(tempDir, { 'tree-sitter-cli': '^0.26.0' });
    writeFakeBinOnlyPackage(tempDir, 'tree-sitter-cli', 'tree-sitter');
    const binaryPath = treeSitterCliBinaryPath(tempDir);
    writeFileSync(binaryPath, 'not executable');
    chmodSync(binaryPath, 0o644);

    expect(() => verifyCriticalModules(tempDir)).toThrow(/tree-sitter-cli executable/);
  });

  it('rejects tree-sitter-cli when an executable returns invalid version output', () => {
    if (process.platform === 'win32') return;

    writeRootPackage(tempDir, { 'tree-sitter-cli': '^0.26.0' });
    writeFakeBinOnlyPackage(tempDir, 'tree-sitter-cli', 'tree-sitter');
    const binaryPath = treeSitterCliBinaryPath(tempDir);
    writeFileSync(binaryPath, '#!/bin/sh\necho corrupt-binary\n');
    chmodSync(binaryPath, 0o755);

    expect(() => verifyCriticalModules(tempDir)).toThrow(/tree-sitter-cli executable/);
  });

  it('runs the top-level tree-sitter-cli installer when its executable is missing', async () => {
    writeRootPackage(tempDir, { 'tree-sitter-cli': '^0.26.0' });
    writeFakeBinOnlyPackage(tempDir, 'tree-sitter-cli', 'tree-sitter');
    const cliDir = join(tempDir, 'node_modules', 'tree-sitter-cli');
    writeFileSync(
      join(cliDir, 'install.js'),
      [
        `const fs = require('fs');`,
        `const binary = ${JSON.stringify(treeSitterCliBinaryPath(tempDir))};`,
        `const contents = process.platform === 'win32' ? 'fixture' : '#!/bin/sh\\necho tree-sitter 0.0.0\\n';`,
        `fs.writeFileSync(binary, contents);`,
        `if (process.platform !== 'win32') fs.chmodSync(binary, 0o755);`,
        '',
      ].join('\n'),
    );

    if (process.platform === 'win32') {
      await ensureTreeSitterCliBinary(
        tempDir,
        (targetDir) => existsSync(treeSitterCliBinaryPath(targetDir)),
      );
    } else {
      await ensureTreeSitterCliBinary(tempDir);
    }

    expect(existsSync(treeSitterCliBinaryPath(tempDir))).toBe(true);
    if (process.platform !== 'win32') {
      expect(() => verifyCriticalModules(tempDir)).not.toThrow();
    }
  });
});
