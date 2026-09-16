import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { logger } from '../../src/utils/logger.js';

// Force the MCP server script to be unresolvable, so addOpenCodeMcpReference
// returns the config without a claude-mem MCP entry — the condition that must
// produce a user-visible warning and a partial-install result.
mock.module('../../src/services/integrations/install-paths.js', () => ({
  getMcpServerAbsolutePath: () => null,
  getNodeAbsolutePath: () => process.execPath,
}));

describe('OpenCode installer missing-MCP-script warning', () => {
  let tempDir: string;
  let previousConfigDir: string | undefined;
  let warnSpy: ReturnType<typeof spyOn>;
  let consoleWarnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    tempDir = join(tmpdir(), `opencode-installer-missing-script-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    previousConfigDir = process.env.OPENCODE_CONFIG_DIR;
    process.env.OPENCODE_CONFIG_DIR = tempDir;
    warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});
    consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    consoleWarnSpy.mockRestore();
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

  function expectUserVisibleWarning(): void {
    // The structured logger writes to a file only; the installer UI buffers
    // console output. The warning must reach that console channel or the user
    // never sees it.
    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
    expect(String(consoleWarnSpy.mock.calls[0]?.[0])).toContain('MCP server script not found');

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [component, message] = warnSpy.mock.calls[0] as unknown[];
    expect(component).toBe('OPENCODE');
    expect(String(message)).toContain('MCP server script not found');
  }

  it('warns and reports partial install when the MCP script is missing even if an unrelated MCP server exists', async () => {
    const { registerOpenCodePluginInConfig, OPENCODE_MCP_REGISTRATION_INCOMPLETE } = await import(
      '../../src/services/integrations/OpenCodeInstaller.js'
    );

    writeFileSync(join(tempDir, 'opencode.json'), JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      plugin: ['context-mode'],
      mcp: { context7: { enabled: true } },
    }), 'utf-8');

    const result = registerOpenCodePluginInConfig();

    // A missing MCP server is a partial install, not a silent success.
    expect(result).toBe(OPENCODE_MCP_REGISTRATION_INCOMPLETE);

    const configPath = join(tempDir, 'opencode.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));

    // The plugin is still registered, the unrelated MCP server is preserved,
    // but no claude-mem MCP entry is written.
    expect(config.plugin).toEqual(['context-mode', './plugins/claude-mem.js']);
    expect(config.mcp).toEqual({ context7: { enabled: true } });
    expect('claude-mem' in config.mcp).toBe(false);

    expectUserVisibleWarning();
  });

  it('warns when a stale claude-mem entry is retained because its script no longer exists', async () => {
    const { registerOpenCodePluginInConfig, OPENCODE_MCP_REGISTRATION_INCOMPLETE } = await import(
      '../../src/services/integrations/OpenCodeInstaller.js'
    );

    // The config already carries a claude-mem entry whose command points at a
    // build that has since been removed. Resolution now fails, so the installer
    // cannot refresh it — but it must not stay silent.
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

    expect(result).toBe(OPENCODE_MCP_REGISTRATION_INCOMPLETE);

    // The stale entry is left untouched (never corrupt user config), but the
    // missing-script warning must fire because no usable entry remains.
    const config = JSON.parse(readFileSync(join(tempDir, 'opencode.json'), 'utf-8'));
    expect(config.mcp['claude-mem']).toEqual({
      type: 'local',
      command: [process.execPath, join(tempDir, 'removed-build', 'mcp-server.cjs')],
    });

    expectUserVisibleWarning();
  });

  it('warns conservatively when resolution fails even if a retained entry names an existing file', async () => {
    const { registerOpenCodePluginInConfig, OPENCODE_MCP_REGISTRATION_INCOMPLETE } = await import(
      '../../src/services/integrations/OpenCodeInstaller.js'
    );

    // The retained command points at an existing but unrelated JavaScript file.
    // The installer cannot verify it is claude-mem's MCP server, so it must warn
    // rather than accept the entry as proof of a working registration.
    const unrelatedScript = join(tempDir, 'unrelated.js');
    writeFileSync(unrelatedScript, 'console.log("not claude-mem");\n', 'utf-8');

    writeFileSync(join(tempDir, 'opencode.json'), JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      plugin: ['./plugins/claude-mem.js'],
      mcp: {
        'claude-mem': {
          type: 'local',
          command: [process.execPath, unrelatedScript],
        },
      },
    }), 'utf-8');

    const result = registerOpenCodePluginInConfig();

    expect(result).toBe(OPENCODE_MCP_REGISTRATION_INCOMPLETE);
    expectUserVisibleWarning();
  });
});
