import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { logger } from '../../src/utils/logger.js';

// Force the MCP server script to be unresolvable, so addOpenCodeMcpReference
// returns the config without a claude-mem MCP entry — the exact condition that
// must still produce a warning even when an unrelated MCP server exists.
mock.module('../../src/services/integrations/install-paths.js', () => ({
  getMcpServerAbsolutePath: () => null,
  getNodeAbsolutePath: () => process.execPath,
}));

describe('OpenCode installer missing-MCP-script warning', () => {
  let tempDir: string;
  let previousConfigDir: string | undefined;
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    tempDir = join(tmpdir(), `opencode-installer-missing-script-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    previousConfigDir = process.env.OPENCODE_CONFIG_DIR;
    process.env.OPENCODE_CONFIG_DIR = tempDir;
    warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    if (previousConfigDir === undefined) {
      delete process.env.OPENCODE_CONFIG_DIR;
    } else {
      process.env.OPENCODE_CONFIG_DIR = previousConfigDir;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  afterAll(() => {
    mock.restore();
  });

  it('warns when the MCP script is missing even if an unrelated MCP server exists', async () => {
    const { registerOpenCodePluginInConfig } = await import(
      '../../src/services/integrations/OpenCodeInstaller.js'
    );

    writeFileSync(join(tempDir, 'opencode.json'), JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      plugin: ['context-mode'],
      mcp: { context7: { enabled: true } },
    }), 'utf-8');

    const result = registerOpenCodePluginInConfig();

    expect(result).toBe(0);

    const configPath = join(tempDir, 'opencode.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));

    // The plugin is still registered, the unrelated MCP server is preserved,
    // but no claude-mem MCP entry is written.
    expect(config.plugin).toEqual(['context-mode', './plugins/claude-mem.js']);
    expect(config.mcp).toEqual({ context7: { enabled: true } });
    expect('claude-mem' in config.mcp).toBe(false);

    // The missing-script warning must still fire.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [component, message] = warnSpy.mock.calls[0] as unknown[];
    expect(component).toBe('OPENCODE');
    expect(String(message)).toContain('MCP server script not found');
  });

  it('warns when a stale claude-mem entry is retained because its script no longer exists', async () => {
    const { registerOpenCodePluginInConfig } = await import(
      '../../src/services/integrations/OpenCodeInstaller.js'
    );

    // Reproduces the P1: the config already carries a claude-mem entry whose
    // command points at a build that has since been removed. Resolution now
    // fails, so the installer cannot refresh it — but it must not stay silent.
    writeFileSync(join(tempDir, 'opencode.json'), JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      plugin: ['./plugins/claude-mem.js'],
      mcp: {
        'claude-mem': {
          type: 'local',
          command: [process.execPath, join(tempDir, 'removed-build', 'mcp-server.cjs')],
        },
      },
    }), 'utf-8');

    const result = registerOpenCodePluginInConfig();

    expect(result).toBe(0);

    // The stale entry is left untouched (never corrupt user config), but the
    // missing-script warning must fire because no usable entry remains.
    const config = JSON.parse(readFileSync(join(tempDir, 'opencode.json'), 'utf-8'));
    expect(config.mcp['claude-mem']).toEqual({
      type: 'local',
      command: [process.execPath, join(tempDir, 'removed-build', 'mcp-server.cjs')],
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [component, message] = warnSpy.mock.calls[0] as unknown[];
    expect(component).toBe('OPENCODE');
    expect(String(message)).toContain('MCP server script not found');
  });

  it('does not warn when a retained claude-mem entry is still usable despite failed resolution', async () => {
    const { registerOpenCodePluginInConfig } = await import(
      '../../src/services/integrations/OpenCodeInstaller.js'
    );

    // A retained entry whose command points at an existing script is usable, so
    // a failed resolution is not a registration failure and must stay quiet.
    writeFileSync(join(tempDir, 'opencode.json'), JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      plugin: ['./plugins/claude-mem.js'],
      mcp: {
        'claude-mem': {
          type: 'local',
          command: [process.execPath, process.execPath],
        },
      },
    }), 'utf-8');

    const result = registerOpenCodePluginInConfig();

    expect(result).toBe(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
