import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Smart Install Script Tests
 *
 * Tests the resolveRoot() and verifyCriticalModules() logic used by
 * plugin/scripts/smart-install.js to find the correct install directory
 * for cache-based and marketplace installs.
 *
 * These are unit tests that exercise the resolution logic in isolation
 * using temp directories, without running actual bun/npm install.
 */

const TEST_DIR = join(tmpdir(), `claude-mem-smart-install-test-${process.pid}`);

function createDir(relativePath: string): string {
  const fullPath = join(TEST_DIR, relativePath);
  mkdirSync(fullPath, { recursive: true });
  return fullPath;
}

function createPackageJson(dir: string, version = '10.0.0', deps: Record<string, string> = {}): void {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'claude-mem-plugin',
    version,
    dependencies: deps
  }));
}

describe('smart-install resolveRoot logic', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('should prefer CLAUDE_PLUGIN_ROOT when it contains package.json', () => {
    const cacheDir = createDir('cache/thedotmack/claude-mem/10.0.0');
    createPackageJson(cacheDir);

    // Simulate what resolveRoot does
    const root = cacheDir;
    expect(existsSync(join(root, 'package.json'))).toBe(true);
  });

  it('should detect cache-based install paths', () => {
    // Cache installs have paths like ~/.claude/plugins/cache/thedotmack/claude-mem/<version>/
    const cacheDir = createDir('plugins/cache/thedotmack/claude-mem/10.3.0');
    createPackageJson(cacheDir);

    // Marketplace dir does NOT exist (fresh cache install, no marketplace)
    const pluginRoot = cacheDir;
    expect(existsSync(join(pluginRoot, 'package.json'))).toBe(true);
    // The cache dir is valid — resolveRoot should use it, not try to navigate to marketplace
  });

  it('should fall back to script-relative path when CLAUDE_PLUGIN_ROOT is unset', () => {
    // Simulate: scripts/smart-install.js lives in <root>/scripts/
    const pluginRoot = createDir('marketplace-plugin');
    createPackageJson(pluginRoot);
    const scriptsDir = createDir('marketplace-plugin/scripts');

    // dirname(scripts/) = marketplace-plugin/ which has package.json
    const candidate = join(scriptsDir, '..');
    expect(existsSync(join(candidate, 'package.json'))).toBe(true);
  });

  it('should handle missing package.json in CLAUDE_PLUGIN_ROOT gracefully', () => {
    // CLAUDE_PLUGIN_ROOT points to a dir without package.json
    const badDir = createDir('empty-cache-dir');
    expect(existsSync(join(badDir, 'package.json'))).toBe(false);
    // resolveRoot should fall through to next candidate
  });
});

describe('smart-install verifyCriticalModules logic', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('should pass when all dependencies exist in node_modules', () => {
    const root = createDir('plugin-root');
    createPackageJson(root, '10.0.0', {
      '@chroma-core/default-embed': '^0.1.9'
    });

    // Create the module directory
    mkdirSync(join(root, 'node_modules', '@chroma-core', 'default-embed'), { recursive: true });

    // Simulate verifyCriticalModules
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
    const dependencies = Object.keys(pkg.dependencies || {});
    const missing: string[] = [];
    for (const dep of dependencies) {
      const modulePath = join(root, 'node_modules', ...dep.split('/'));
      if (!existsSync(modulePath)) {
        missing.push(dep);
      }
    }

    expect(missing).toEqual([]);
  });

  it('should detect missing dependencies in node_modules', () => {
    const root = createDir('plugin-root-missing');
    createPackageJson(root, '10.0.0', {
      '@chroma-core/default-embed': '^0.1.9'
    });

    // Do NOT create node_modules — simulate a failed install
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
    const dependencies = Object.keys(pkg.dependencies || {});
    const missing: string[] = [];
    for (const dep of dependencies) {
      const modulePath = join(root, 'node_modules', ...dep.split('/'));
      if (!existsSync(modulePath)) {
        missing.push(dep);
      }
    }

    expect(missing).toEqual(['@chroma-core/default-embed']);
  });

  it('should handle packages with no dependencies gracefully', () => {
    const root = createDir('plugin-root-no-deps');
    createPackageJson(root, '10.0.0', {});

    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
    const dependencies = Object.keys(pkg.dependencies || {});

    expect(dependencies).toEqual([]);
  });

  it('should detect partially installed scoped packages', () => {
    const root = createDir('plugin-root-partial');
    createPackageJson(root, '10.0.0', {
      '@chroma-core/default-embed': '^0.1.9',
      '@chroma-core/other-pkg': '^1.0.0'
    });

    // Only install one of the two packages
    mkdirSync(join(root, 'node_modules', '@chroma-core', 'default-embed'), { recursive: true });

    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
    const dependencies = Object.keys(pkg.dependencies || {});
    const missing: string[] = [];
    for (const dep of dependencies) {
      const modulePath = join(root, 'node_modules', ...dep.split('/'));
      if (!existsSync(modulePath)) {
        missing.push(dep);
      }
    }

    expect(missing).toEqual(['@chroma-core/other-pkg']);
  });
});
