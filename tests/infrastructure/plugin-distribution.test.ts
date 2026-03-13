import { describe, it, expect } from 'bun:test';
import { readFileSync, existsSync, statSync } from 'fs';
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
    'plugin/scripts/bun-exec-runner.sh',
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
});


describe('Plugin Distribution - bun-exec-runner.sh (#1249)', () => {
  const scriptPath = path.join(projectRoot, 'plugin/scripts/bun-exec-runner.sh');

  it('should exist and be executable', () => {
    expect(existsSync(scriptPath)).toBe(true);
    const stats = statSync(scriptPath);
    // Check execute permission (owner)
    expect(stats.mode & 0o100).toBeTruthy();
  });

  it('should have a POSIX shell shebang', () => {
    const content = readFileSync(scriptPath, 'utf-8');
    expect(content.startsWith('#!/bin/sh')).toBe(true);
  });

  it('should use exec to avoid grandchild process tree', () => {
    const content = readFileSync(scriptPath, 'utf-8');
    // Must use exec to replace shell with bun (key fix for #1249)
    expect(content).toContain('exec "$_BUN"');
  });

  it('should check common bun install locations', () => {
    const content = readFileSync(scriptPath, 'utf-8');
    expect(content).toContain('$HOME/.bun/bin/bun');
    expect(content).toContain('/opt/homebrew/bin/bun');
    expect(content).toContain('/usr/local/bin/bun');
  });

  it('should fall back to node bun-runner.js', () => {
    const content = readFileSync(scriptPath, 'utf-8');
    expect(content).toContain('bun-runner.js');
  });
});

describe('Plugin Distribution - hooks.json uses bun-exec-runner.sh (#1249)', () => {
  it('should use bun-exec-runner.sh instead of node bun-runner.js for worker hooks', () => {
    const hooksPath = path.join(projectRoot, 'plugin/hooks/hooks.json');
    const parsed = JSON.parse(readFileSync(hooksPath, 'utf-8'));

    // Collect all hook commands that invoke worker-service.cjs
    const workerCommands: string[] = [];
    for (const [eventName, matchers] of Object.entries(parsed.hooks)) {
      for (const matcher of matchers as any[]) {
        for (const hook of matcher.hooks) {
          if (hook.type === 'command' && hook.command.includes('worker-service.cjs')) {
            workerCommands.push(hook.command);
          }
        }
      }
    }

    expect(workerCommands.length).toBeGreaterThan(0);
    for (const cmd of workerCommands) {
      // Must use bun-exec-runner.sh, NOT node bun-runner.js
      expect(cmd).toContain('bun-exec-runner.sh');
      expect(cmd).not.toContain('node "$_R/scripts/bun-runner.js"');
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
