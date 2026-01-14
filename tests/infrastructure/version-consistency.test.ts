import { describe, it, expect } from 'bun:test';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');

/**
 * Test suite to ensure version consistency across all package.json files
 * and built artifacts.
 *
 * This prevents the infinite restart loop issue where:
 * - Plugin reads version from plugin/package.json
 * - Worker returns built-in version from bundled code
 * - Mismatch triggers restart on every hook call
 */
describe('Version Consistency', () => {
  let rootVersion: string;

  it('should read version from root package.json', () => {
    const packageJsonPath = path.join(projectRoot, 'package.json');
    expect(existsSync(packageJsonPath)).toBe(true);
    
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    expect(packageJson.version).toBeDefined();
    expect(packageJson.version).toMatch(/^\d+\.\d+\.\d+$/);
    
    rootVersion = packageJson.version;
  });

  it('should have matching version in plugin/package.json', () => {
    const pluginPackageJsonPath = path.join(projectRoot, 'plugin/package.json');
    expect(existsSync(pluginPackageJsonPath)).toBe(true);
    
    const pluginPackageJson = JSON.parse(readFileSync(pluginPackageJsonPath, 'utf-8'));
    expect(pluginPackageJson.version).toBe(rootVersion);
  });

  it('should have matching version in plugin/.claude-plugin/plugin.json', () => {
    const pluginJsonPath = path.join(projectRoot, 'plugin/.claude-plugin/plugin.json');
    expect(existsSync(pluginJsonPath)).toBe(true);
    
    const pluginJson = JSON.parse(readFileSync(pluginJsonPath, 'utf-8'));
    expect(pluginJson.version).toBe(rootVersion);
  });

  it('should have matching version in .claude-plugin/marketplace.json', () => {
    const marketplaceJsonPath = path.join(projectRoot, '.claude-plugin/marketplace.json');
    expect(existsSync(marketplaceJsonPath)).toBe(true);
    
    const marketplaceJson = JSON.parse(readFileSync(marketplaceJsonPath, 'utf-8'));
    expect(marketplaceJson.plugins).toBeDefined();
    expect(marketplaceJson.plugins.length).toBeGreaterThan(0);
    
    const claudeMemPlugin = marketplaceJson.plugins.find((p: any) => p.name === 'claude-mem');
    expect(claudeMemPlugin).toBeDefined();
    expect(claudeMemPlugin.version).toBe(rootVersion);
  });

  it('should have version injected into built worker-service.cjs', () => {
    const workerServicePath = path.join(projectRoot, 'plugin/scripts/worker-service.cjs');
    
    // Skip if file doesn't exist (e.g., before first build)
    if (!existsSync(workerServicePath)) {
      console.log('⚠️  worker-service.cjs not found - run npm run build first');
      return;
    }
    
    const workerServiceContent = readFileSync(workerServicePath, 'utf-8');
    
    // The build script injects version via esbuild define:
    // define: { '__DEFAULT_PACKAGE_VERSION__': `"${version}"` }
    // This becomes: const BUILT_IN_VERSION = "9.0.0" (or minified: Bre="9.0.0")
    
    // Check for the version string in the minified code
    const versionPattern = new RegExp(`"${rootVersion.replace(/\./g, '\\.')}"`, 'g');
    const matches = workerServiceContent.match(versionPattern);
    
    expect(matches).toBeTruthy();
    expect(matches!.length).toBeGreaterThan(0);
  });

  it('should have built mcp-server.cjs', () => {
    const mcpServerPath = path.join(projectRoot, 'plugin/scripts/mcp-server.cjs');

    // Skip if file doesn't exist (e.g., before first build)
    if (!existsSync(mcpServerPath)) {
      console.log('⚠️  mcp-server.cjs not found - run npm run build first');
      return;
    }

    // mcp-server.cjs doesn't use __DEFAULT_PACKAGE_VERSION__ - it's a search server
    // that doesn't need to expose version info. Just verify it exists and is built.
    const mcpServerContent = readFileSync(mcpServerPath, 'utf-8');
    expect(mcpServerContent.length).toBeGreaterThan(0);
  });

  it('should validate version format is semver compliant', () => {
    // Ensure version follows semantic versioning: MAJOR.MINOR.PATCH
    expect(rootVersion).toMatch(/^\d+\.\d+\.\d+$/);
    
    const [major, minor, patch] = rootVersion.split('.').map(Number);
    expect(major).toBeGreaterThanOrEqual(0);
    expect(minor).toBeGreaterThanOrEqual(0);
    expect(patch).toBeGreaterThanOrEqual(0);
  });
});

/**
 * Additional test to ensure build script properly reads and injects version
 */
describe('Build Script Version Handling', () => {
  it('should read version from package.json in build-hooks.js', () => {
    const buildScriptPath = path.join(projectRoot, 'scripts/build-hooks.js');
    expect(existsSync(buildScriptPath)).toBe(true);
    
    const buildScriptContent = readFileSync(buildScriptPath, 'utf-8');
    
    // Verify build script reads from package.json
    expect(buildScriptContent).toContain("readFileSync('package.json'");
    expect(buildScriptContent).toContain('packageJson.version');
    
    // Verify it generates plugin/package.json with the version
    expect(buildScriptContent).toContain('version: version');
    
    // Verify it injects version into esbuild define
    expect(buildScriptContent).toContain('__DEFAULT_PACKAGE_VERSION__');
    expect(buildScriptContent).toContain('`"${version}"`');
  });
});
