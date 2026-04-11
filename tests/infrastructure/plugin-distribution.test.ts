import { describe, it, expect } from 'bun:test';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');

/**
 * Regression tests for plugin distribution completeness.
 * Ensures all required files (skills, hooks, manifests) are present
 * and correctly structured for end-user installs.
 *
 * Prevents issue #1187 (missing skills/ directory after install).
 */
describe('Plugin Distribution - Skills', () => {
  const skillPath = path.join(projectRoot, 'plugin/skills/mem-search/SKILL.md');

  it('should include plugin/skills/mem-search/SKILL.md', () => {
    expect(existsSync(skillPath)).toBe(true);
  });

  it('should have valid YAML frontmatter with name and description', () => {
    const content = readFileSync(skillPath, 'utf-8');

    // Must start with YAML frontmatter
    expect(content.startsWith('---\n')).toBe(true);

    // Extract frontmatter
    const frontmatterEnd = content.indexOf('\n---\n', 4);
    expect(frontmatterEnd).toBeGreaterThan(0);

    const frontmatter = content.slice(4, frontmatterEnd);
    expect(frontmatter).toContain('name:');
    expect(frontmatter).toContain('description:');
  });

  it('should reference the 3-layer search workflow', () => {
    const content = readFileSync(skillPath, 'utf-8');
    // The skill must document the search → timeline → get_observations workflow
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
            // Cache lookup must appear before the final marketplaces fallback
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

    // Build script must check for critical distribution files
    expect(content).toContain('plugin/skills/mem-search/SKILL.md');
    expect(content).toContain('plugin/hooks/hooks.json');
    expect(content).toContain('plugin/.claude-plugin/plugin.json');
  });
});

describe('Plugin Distribution - Setup Hook (#1547)', () => {
  it('should not reference removed setup.sh in Setup hook', () => {
    // setup.sh was removed; the Setup hook must not reference it or the
    // plugin silently fails to install on Linux (hooks disabled on setup failure).
    const hooksPath = path.join(projectRoot, 'plugin/hooks/hooks.json');
    const content = readFileSync(hooksPath, 'utf-8');
    expect(content).not.toContain('setup.sh');
  });

  it('should call smart-install.js in the Setup hook', () => {
    const hooksPath = path.join(projectRoot, 'plugin/hooks/hooks.json');
    const parsed = JSON.parse(readFileSync(hooksPath, 'utf-8'));
    const setupHooks: any[] = parsed.hooks['Setup'] ?? [];

    // Collect all command hooks from all matchers
    const commandHooks = setupHooks.flatMap((matcher: any) =>
      (matcher.hooks ?? []).filter((h: any) => h.type === 'command')
    );

    // There must be at least one command hook — otherwise the test vacuously passes
    expect(commandHooks.length).toBeGreaterThan(0);

    // At least one command hook must reference smart-install.js
    const smartInstallHooks = commandHooks.filter((h: any) =>
      h.command?.includes('smart-install.js')
    );
    expect(smartInstallHooks.length).toBeGreaterThan(0);
  });

  it('smart-install.js referenced by Setup hook should exist on disk', () => {
    const smartInstallPath = path.join(projectRoot, 'plugin/scripts/smart-install.js');
    expect(existsSync(smartInstallPath)).toBe(true);
  });
});
