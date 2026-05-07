import { describe, it, expect } from 'bun:test';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');

function readJson(relativePath: string): any {
  return JSON.parse(readFileSync(path.join(projectRoot, relativePath), 'utf-8'));
}

function commandHooksFrom(relativePath: string): string[] {
  const parsed = readJson(relativePath);
  return Object.values(parsed.hooks ?? {}).flatMap((matchers: any) =>
    matchers.flatMap((matcher: any) =>
      (matcher.hooks ?? [])
        .filter((hook: any) => hook.type === 'command')
        .map((hook: any) => String(hook.command ?? ''))
    )
  );
}

function mcpStartupCommandFrom(relativePath: string): string {
  const parsed = readJson(relativePath);
  return parsed.mcpServers['mcp-search'].args[1];
}

describe('Plugin Distribution - Skills', () => {
  const skillPath = path.join(projectRoot, 'plugin/skills/mem-search/SKILL.md');

  it('should include plugin/skills/mem-search/SKILL.md', () => {
    expect(existsSync(skillPath)).toBe(true);
  });

  it('should have valid YAML frontmatter with name and description', () => {
    const content = readFileSync(skillPath, 'utf-8');

    expect(content.startsWith('---\n')).toBe(true);

    const frontmatterEnd = content.indexOf('\n---\n', 4);
    expect(frontmatterEnd).toBeGreaterThan(0);

    const frontmatter = content.slice(4, frontmatterEnd);
    expect(frontmatter).toContain('name:');
    expect(frontmatter).toContain('description:');
  });

  it('should reference the 3-layer search workflow', () => {
    const content = readFileSync(skillPath, 'utf-8');
    expect(content).toContain('search');
    expect(content).toContain('timeline');
    expect(content).toContain('get_observations');
  });
});

describe('Plugin Distribution - Required Files', () => {
  const requiredFiles = [
    'plugin/hooks/hooks.json',
    'plugin/hooks/codex-hooks.json',
    'plugin/.claude-plugin/plugin.json',
    'plugin/.codex-plugin/plugin.json',
    'plugin/.mcp.json',
    'plugin/skills/mem-search/SKILL.md',
    '.agents/plugins/marketplace.json',
  ];

  for (const filePath of requiredFiles) {
    it(`should include ${filePath}`, () => {
      const fullPath = path.join(projectRoot, filePath);
      expect(existsSync(fullPath)).toBe(true);
    });
  }
});

describe('Plugin Distribution - Codex Marketplace', () => {
  it('points Codex at the bundled plugin root', () => {
    const marketplacePath = path.join(projectRoot, '.agents/plugins/marketplace.json');
    const marketplace = JSON.parse(readFileSync(marketplacePath, 'utf-8'));

    expect(marketplace.plugins[0].source.path).toBe('./plugin');
  });

  it('MCP launcher can recover without plugin root environment variables', () => {
    const mcpPath = path.join(projectRoot, 'plugin/.mcp.json');
    const mcp = JSON.parse(readFileSync(mcpPath, 'utf-8'));
    const command = mcp.mcpServers['mcp-search'].args.join(' ');

    expect(command).toContain('.codex/plugins/cache/claude-mem-local/claude-mem');
    expect(command).toContain('plugins/cache/thedotmack/claude-mem');
    expect(command).toContain('claude-mem: mcp server not found');
  });

  it('keeps root and bundled MCP launchers in sync', () => {
    const rootMcp = JSON.parse(readFileSync(path.join(projectRoot, '.mcp.json'), 'utf-8'));
    const bundledMcp = JSON.parse(readFileSync(path.join(projectRoot, 'plugin/.mcp.json'), 'utf-8'));

    expect(rootMcp.mcpServers['mcp-search']).toEqual(bundledMcp.mcpServers['mcp-search']);
  });
});

describe('Plugin Distribution - hooks.json Integrity', () => {
  it('should have valid JSON in hooks.json', () => {
    const hooksPath = path.join(projectRoot, 'plugin/hooks/hooks.json');
    const content = readFileSync(hooksPath, 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed.hooks).toBeDefined();
  });

  it('should reference CLAUDE_PLUGIN_ROOT in all hook commands', () => {
    for (const command of commandHooksFrom('plugin/hooks/hooks.json')) {
      expect(command).toContain('CLAUDE_PLUGIN_ROOT');
    }
  });

  it('should include CLAUDE_PLUGIN_ROOT fallback in all hook commands (#1215)', () => {
    const expectedFallbackPath = '$_C/plugins/marketplaces/thedotmack/plugin';

    for (const command of commandHooksFrom('plugin/hooks/hooks.json')) {
      expect(command).toContain(expectedFallbackPath);
    }
  });

  it('should try cache path before marketplaces fallback in all hook commands (#1533)', () => {
    const cachePath = '$_C/plugins/cache/thedotmack/claude-mem';
    const marketplacesPath = '$_C/plugins/marketplaces/thedotmack/plugin';

    for (const command of commandHooksFrom('plugin/hooks/hooks.json')) {
      expect(command).toContain(cachePath);
      expect(command.indexOf(cachePath)).toBeLessThan(command.indexOf(marketplacesPath));
    }
  });
});

describe('Plugin Distribution - Startup Root Resolution', () => {
  it('MCP startup commands should have config-dir based non-empty fallbacks', () => {
    for (const relativePath of ['.mcp.json', 'plugin/.mcp.json']) {
      const command = mcpStartupCommandFrom(relativePath);

      expect(command).toContain('${CLAUDE_CONFIG_DIR:-$HOME/.claude}');
      expect(command).toContain('_E="${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-}}"');
      expect(command).toContain('while IFS= read -r _R');
      expect(command).toContain('$_C/plugins/marketplaces/thedotmack/plugin');
      expect(command).toContain('$_C/plugins/cache/thedotmack/claude-mem');
      expect(command).toContain('[ -f "$_Q/scripts/mcp-server.cjs" ]');
      expect(command).not.toContain('"/scripts/mcp-server.cjs"');
      expect(command.indexOf('$_C/plugins/cache/thedotmack/claude-mem')).toBeLessThan(
        command.indexOf('$_C/plugins/marketplaces/thedotmack/plugin')
      );
    }
  });

  it('Codex hook commands should have config-dir based non-empty fallbacks', () => {
    for (const command of commandHooksFrom('plugin/hooks/codex-hooks.json')) {
      expect(command).toContain('${CLAUDE_CONFIG_DIR:-$HOME/.claude}');
      expect(command).toContain('export PATH=');
      expect(command).toContain('while IFS= read -r _R');
      expect(command).toContain('$_C/plugins/marketplaces/thedotmack/plugin');
      expect(command).toContain('$_C/plugins/cache/thedotmack/claude-mem');
      expect(command).toContain('[ -f "$_Q/scripts/');
      expect(command).toContain('command -v cygpath');
      expect(command.indexOf('$_C/plugins/cache/thedotmack/claude-mem')).toBeLessThan(
        command.indexOf('$_C/plugins/marketplaces/thedotmack/plugin')
      );
    }
  });

  it('Claude hook commands should have config-dir based non-empty fallbacks', () => {
    for (const command of commandHooksFrom('plugin/hooks/hooks.json')) {
      expect(command).toContain('${CLAUDE_CONFIG_DIR:-$HOME/.claude}');
      expect(command).toContain('while IFS= read -r _R');
      expect(command).toContain('$_C/plugins/marketplaces/thedotmack/plugin');
      expect(command).toContain('$_C/plugins/cache/thedotmack/claude-mem');
      expect(command).toContain('[ -f "$_Q/scripts/');
      expect(command).not.toContain('$HOME/.claude/plugins/');
    }
  });
});

describe('Plugin Distribution - package.json Files Field', () => {
  it('should include bundled plugin entries in root package.json files field', () => {
    const packageJsonPath = path.join(projectRoot, 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    expect(packageJson.files).toBeDefined();
    expect(packageJson.files).toContain('plugin/.codex-plugin');
    expect(packageJson.files).toContain('plugin/.mcp.json');
    expect(packageJson.files).toContain('plugin/hooks');
    expect(packageJson.files).toContain('plugin/skills');
    expect(packageJson.files).toContain('plugin/scripts/*.cjs');
  });
});

describe('Plugin Distribution - Build Script Verification', () => {
  it('should verify distribution files in build-hooks.js', () => {
    const buildScriptPath = path.join(projectRoot, 'scripts/build-hooks.js');
    const content = readFileSync(buildScriptPath, 'utf-8');

    expect(content).toContain('plugin/skills/mem-search/SKILL.md');
    expect(content).toContain('plugin/hooks/hooks.json');
    expect(content).toContain('plugin/.claude-plugin/plugin.json');
  });
});

describe('Plugin Distribution - Setup Hook (#1547)', () => {
  it('should not reference removed setup.sh in Setup hook', () => {
    const hooksPath = path.join(projectRoot, 'plugin/hooks/hooks.json');
    const content = readFileSync(hooksPath, 'utf-8');
    expect(content).not.toContain('setup.sh');
  });

  it('should call version-check.js in the Setup hook', () => {
    const hooksPath = path.join(projectRoot, 'plugin/hooks/hooks.json');
    const parsed = JSON.parse(readFileSync(hooksPath, 'utf-8'));
    const setupHooks: any[] = parsed.hooks['Setup'] ?? [];

    const commandHooks = setupHooks.flatMap((matcher: any) =>
      (matcher.hooks ?? []).filter((h: any) => h.type === 'command')
    );

    expect(commandHooks.length).toBeGreaterThan(0);

    const versionCheckHooks = commandHooks.filter((h: any) =>
      h.command?.includes('version-check.js')
    );
    expect(versionCheckHooks.length).toBeGreaterThan(0);
  });

  it('version-check.js referenced by Setup hook should exist on disk', () => {
    const versionCheckPath = path.join(projectRoot, 'plugin/scripts/version-check.js');
    expect(existsSync(versionCheckPath)).toBe(true);
  });
});
