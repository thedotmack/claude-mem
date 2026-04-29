import { describe, it, expect } from 'bun:test';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');

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
    'plugin/.claude-plugin/plugin.json',
    'plugin/skills/mem-search/SKILL.md',
  ];

  for (const filePath of requiredFiles) {
    it(`should include ${filePath}`, () => {
      const fullPath = path.join(projectRoot, filePath);
      expect(existsSync(fullPath)).toBe(true);
    });
  }
});

describe('Plugin Distribution - hooks.json Integrity', () => {
  it('should have valid JSON in hooks.json', () => {
    const hooksPath = path.join(projectRoot, 'plugin/hooks/hooks.json');
    const content = readFileSync(hooksPath, 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed.hooks).toBeDefined();
  });

  it('should reference CLAUDE_PLUGIN_ROOT in all hook commands', () => {
    const hooksPath = path.join(projectRoot, 'plugin/hooks/hooks.json');
    const parsed = JSON.parse(readFileSync(hooksPath, 'utf-8'));

    for (const [eventName, matchers] of Object.entries(parsed.hooks)) {
      for (const matcher of matchers as any[]) {
        for (const hook of matcher.hooks) {
          if (hook.type === 'command') {
            expect(hook.command).toContain('${CLAUDE_PLUGIN_ROOT}');
          }
        }
      }
    }
  });

  it('should include CLAUDE_PLUGIN_ROOT fallback in all hook commands (#1215)', () => {
    const hooksPath = path.join(projectRoot, 'plugin/hooks/hooks.json');
    const parsed = JSON.parse(readFileSync(hooksPath, 'utf-8'));
    const expectedFallbackPath = '$HOME/.claude/plugins/marketplaces/thedotmack/plugin';

    for (const [eventName, matchers] of Object.entries(parsed.hooks)) {
      for (const matcher of matchers as any[]) {
        for (const hook of matcher.hooks) {
          if (hook.type === 'command') {
            expect(hook.command).toContain(expectedFallbackPath);
          }
        }
      }
    }
  });

  it('should try cache path before marketplaces fallback in all hook commands (#1533)', () => {
    const hooksPath = path.join(projectRoot, 'plugin/hooks/hooks.json');
    const parsed = JSON.parse(readFileSync(hooksPath, 'utf-8'));
    const cachePath = '$HOME/.claude/plugins/cache/thedotmack/claude-mem';
    const marketplacesPath = '$HOME/.claude/plugins/marketplaces/thedotmack/plugin';

    for (const [eventName, matchers] of Object.entries(parsed.hooks)) {
      for (const matcher of matchers as any[]) {
        for (const hook of matcher.hooks) {
          if (hook.type === 'command') {
            expect(hook.command).toContain(cachePath);
            expect(hook.command.indexOf(cachePath)).toBeLessThan(hook.command.indexOf(marketplacesPath));
          }
        }
      }
    }
  });
});

describe('Plugin Distribution - package.json Files Field', () => {
  it('should include "plugin" in root package.json files field', () => {
    const packageJsonPath = path.join(projectRoot, 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    expect(packageJson.files).toBeDefined();
    expect(packageJson.files).toContain('plugin');
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
