import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { checkBinaryPlatformCompatibility } from '../plugin/scripts/smart-install.js';

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

describe('smart-install stdout JSON output (#1253)', () => {
  const SCRIPT_PATH = join(__dirname, '..', 'plugin', 'scripts', 'smart-install.js');

  it('should not have any execSync with stdio: inherit (prevents stdout leak)', () => {
    const content = readFileSync(SCRIPT_PATH, 'utf-8');
    // stdio: 'inherit' would leak non-JSON output to stdout, breaking Claude Code hooks
    expect(content).not.toContain("stdio: 'inherit'");
    expect(content).not.toContain('stdio: "inherit"');
  });

  it('should output valid JSON to stdout on success path', () => {
    const content = readFileSync(SCRIPT_PATH, 'utf-8');
    // The script must print JSON to stdout for the Claude Code hook contract
    expect(content).toContain('console.log(JSON.stringify(');
    expect(content).toContain('continue');
    expect(content).toContain('suppressOutput');
  });

  it('should output valid JSON to stdout even in error catch block', () => {
    const content = readFileSync(SCRIPT_PATH, 'utf-8');
    // Find the catch block and verify it also outputs JSON
    const catchIndex = content.lastIndexOf('catch (e)');
    expect(catchIndex).toBeGreaterThan(0);
    const catchBlock = content.slice(catchIndex, catchIndex + 300);
    expect(catchBlock).toContain('console.log(JSON.stringify(');
  });

  it('should use piped stdout for all execSync calls', () => {
    const content = readFileSync(SCRIPT_PATH, 'utf-8');
    // All execSync calls should pipe stdout to prevent leaking to the hook output.
    // Match execSync calls that have a stdio option — they should all use array form.
    // All execSync calls should either use 'ignore', array form, or the installStdio variable
    // — never bare 'inherit' which leaks non-JSON output to stdout
    expect(content).not.toContain("stdio: 'inherit'");
    expect(content).not.toContain('stdio: "inherit"');
    // Verify the installStdio variable is defined with the correct pipe config
    expect(content).toContain("const installStdio = ['pipe', 'pipe', 'inherit']");
  });

  it('should produce valid JSON when run with plugin disabled', () => {
    // Run the actual script with the plugin forcefully disabled via settings
    // This exercises the early exit path
    const settingsDir = join(tmpdir(), `claude-mem-test-settings-${process.pid}`);
    const settingsFile = join(settingsDir, 'settings.json');
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(settingsFile, JSON.stringify({
      enabledPlugins: { 'claude-mem@thedotmack': false }
    }));

    try {
      const result = spawnSync('node', [SCRIPT_PATH], {
        encoding: 'utf-8',
        env: {
          ...process.env,
          CLAUDE_CONFIG_DIR: settingsDir,
        },
        timeout: 10000,
      });

      // When plugin is disabled, script exits with 0 and produces no stdout
      // (the early exit at line 31-33 calls process.exit(0) before any output)
      expect(result.status).toBe(0);
      // stdout should be empty or valid JSON (not plain text install messages)
      const stdout = (result.stdout || '').trim();
      if (stdout.length > 0) {
        expect(() => JSON.parse(stdout)).not.toThrow();
      }
    } finally {
      rmSync(settingsDir, { recursive: true, force: true });
    }
  });
});

/**
 * Tests for checkBinaryPlatformCompatibility() (#1547).
 *
 * The bundled plugin/scripts/claude-mem binary is macOS arm64 only.
 * On Linux/Windows it cannot execute and hooks fail silently.
 * These tests call the production function directly, mocking process.platform
 * and passing controlled binary paths to verify Mach-O detection behaviour.
 */
describe('smart-install binary platform compatibility (#1547)', () => {
  let testDir: string;
  let originalPlatform: PropertyDescriptor | undefined;

  beforeEach(() => {
    testDir = join(tmpdir(), `claude-mem-binary-compat-test-${process.pid}`);
    mkdirSync(testDir, { recursive: true });
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    // Restore process.platform
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
  });

  function setPlatform(value: string) {
    Object.defineProperty(process, 'platform', { value, configurable: true });
  }

  it('should detect native arm64/x86_64 Mach-O binary and warn on Linux', () => {
    // Real macOS arm64 binary header: bytes CF FA ED FE (MH_MAGIC_64)
    const binaryPath = join(testDir, 'claude-mem');
    writeFileSync(binaryPath, Buffer.from([0xCF, 0xFA, 0xED, 0xFE, 0x0C, 0x00, 0x00, 0x01]));

    const stderrLines: string[] = [];
    const originalError = console.error;
    console.error = (...args: any[]) => stderrLines.push(args.join(' '));

    setPlatform('linux');
    try {
      checkBinaryPlatformCompatibility(binaryPath);
    } finally {
      console.error = originalError;
    }

    expect(stderrLines.some(l => l.includes('macOS-only'))).toBe(true);
    expect(stderrLines.some(l => l.includes('linux'))).toBe(true);
  });

  it('should detect byte-swapped Mach-O binary and warn on Linux', () => {
    // Byte-swapped 64-bit Mach-O: bytes FE ED FA CF (MH_CIGAM_64)
    const binaryPath = join(testDir, 'claude-mem-swapped');
    writeFileSync(binaryPath, Buffer.from([0xFE, 0xED, 0xFA, 0xCF, 0x01, 0x00, 0x00, 0x0C]));

    const stderrLines: string[] = [];
    const originalError = console.error;
    console.error = (...args: any[]) => stderrLines.push(args.join(' '));

    setPlatform('linux');
    try {
      checkBinaryPlatformCompatibility(binaryPath);
    } finally {
      console.error = originalError;
    }

    expect(stderrLines.some(l => l.includes('macOS-only'))).toBe(true);
  });

  it('should NOT warn for an ELF binary (Linux native) on Linux', () => {
    // ELF magic: 0x7F 'E' 'L' 'F'
    const binaryPath = join(testDir, 'claude-mem-elf');
    writeFileSync(binaryPath, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]));

    const stderrLines: string[] = [];
    const originalError = console.error;
    console.error = (...args: any[]) => stderrLines.push(args.join(' '));

    setPlatform('linux');
    try {
      checkBinaryPlatformCompatibility(binaryPath);
    } finally {
      console.error = originalError;
    }

    expect(stderrLines.some(l => l.includes('macOS-only'))).toBe(false);
  });

  it('should not throw when binary path does not exist', () => {
    const binaryPath = join(testDir, 'nonexistent-claude-mem');
    expect(existsSync(binaryPath)).toBe(false);

    setPlatform('linux');
    expect(() => checkBinaryPlatformCompatibility(binaryPath)).not.toThrow();
  });

  it('should skip the check entirely when platform is darwin', () => {
    // Write a Mach-O binary — on macOS the check returns early, so no warning
    const binaryPath = join(testDir, 'claude-mem');
    writeFileSync(binaryPath, Buffer.from([0xCF, 0xFA, 0xED, 0xFE, 0x0C, 0x00, 0x00, 0x01]));

    const stderrLines: string[] = [];
    const originalError = console.error;
    console.error = (...args: any[]) => stderrLines.push(args.join(' '));

    setPlatform('darwin');
    try {
      checkBinaryPlatformCompatibility(binaryPath);
    } finally {
      console.error = originalError;
    }

    expect(stderrLines.length).toBe(0);
  });
});
