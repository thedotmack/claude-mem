import { describe, it, expect } from 'bun:test';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');

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
    
    if (!existsSync(workerServicePath)) {
      console.log('⚠️  worker-service.cjs not found - run npm run build first');
      return;
    }
    
    const workerServiceContent = readFileSync(workerServicePath, 'utf-8');

    const versionPattern = new RegExp(`"${rootVersion.replace(/\./g, '\\.')}"`, 'g');
    const matches = workerServiceContent.match(versionPattern);
    
    expect(matches).toBeTruthy();
    expect(matches!.length).toBeGreaterThan(0);
  });

  it('should have built mcp-server.cjs', () => {
    const mcpServerPath = path.join(projectRoot, 'plugin/scripts/mcp-server.cjs');

    if (!existsSync(mcpServerPath)) {
      console.log('⚠️  mcp-server.cjs not found - run npm run build first');
      return;
    }

    const mcpServerContent = readFileSync(mcpServerPath, 'utf-8');
    expect(mcpServerContent.length).toBeGreaterThan(0);
  });

  it('should validate version format is semver compliant', () => {
    expect(rootVersion).toMatch(/^\d+\.\d+\.\d+$/);
    
    const [major, minor, patch] = rootVersion.split('.').map(Number);
    expect(major).toBeGreaterThanOrEqual(0);
    expect(minor).toBeGreaterThanOrEqual(0);
    expect(patch).toBeGreaterThanOrEqual(0);
  });
});

describe('Build Script Version Handling', () => {
  it('should read version from package.json in build-hooks.js', () => {
    const buildScriptPath = path.join(projectRoot, 'scripts/build-hooks.js');
    expect(existsSync(buildScriptPath)).toBe(true);
    
    const buildScriptContent = readFileSync(buildScriptPath, 'utf-8');
    
    expect(buildScriptContent).toContain("readFileSync('package.json'");
    expect(buildScriptContent).toContain('packageJson.version');
    
    expect(buildScriptContent).toContain('version: version');
    
    expect(buildScriptContent).toContain('__DEFAULT_PACKAGE_VERSION__');
    expect(buildScriptContent).toContain('`"${version}"`');
  });
});
