import { afterAll, describe, expect, it, mock } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as realPaths from '../../../../src/shared/paths.js';

// In an installed plugin the worker bundle runs from <pluginRoot>/scripts, so
// getPackageRoot() is the plugin root and .mcp.json sits directly in it.
const pluginRoot = mkdtempSync(join(tmpdir(), 'cm-mcp-plugin-root-'));
const realPathsSnapshot = { ...realPaths };
mock.module('../../../../src/shared/paths.js', () => ({ ...realPathsSnapshot, getPackageRoot: () => pluginRoot }));

const { SettingsRoutes } = await import('../../../../src/services/worker/http/routes/SettingsRoutes.js');

afterAll(() => {
  mock.module('../../../../src/shared/paths.js', () => realPathsSnapshot);
  rmSync(pluginRoot, { recursive: true, force: true });
});

describe('MCP status/toggle in an installed plugin layout', () => {
  it('reports and toggles the .mcp.json at the plugin root', () => {
    mkdirSync(join(pluginRoot, 'scripts'), { recursive: true });
    writeFileSync(join(pluginRoot, '.mcp.json'), '{"mcpServers":{}}');
    const routes = new SettingsRoutes({} as any) as any;

    expect(routes.isMcpEnabled()).toBe(true);

    routes.toggleMcp(false);
    expect(existsSync(join(pluginRoot, '.mcp.json'))).toBe(false);
    expect(existsSync(join(pluginRoot, '.mcp.json.disabled'))).toBe(true);
    expect(routes.isMcpEnabled()).toBe(false);

    routes.toggleMcp(true);
    expect(existsSync(join(pluginRoot, '.mcp.json'))).toBe(true);
    expect(routes.isMcpEnabled()).toBe(true);
  });
});
