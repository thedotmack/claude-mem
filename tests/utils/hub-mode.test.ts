/**
 * Hub Mode Tests
 *
 * Tests for hub mode configuration loading and project resolution.
 * Source: src/utils/project-name.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';
import {
  loadHubConfig,
  resolveProjectFromFilePath,
  clearHubConfigCache,
  getProjectContext,
  getProjectName
} from '../../src/utils/project-name.js';

describe('Hub Mode', () => {
  let tmpDir: string;

  beforeEach(() => {
    clearHubConfigCache();
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'hub-mode-test-'));
  });

  afterEach(() => {
    clearHubConfigCache();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('loadHubConfig', () => {
    it('returns null when no config file exists', () => {
      expect(loadHubConfig(tmpDir)).toBeNull();
    });

    it('returns null for null/undefined cwd', () => {
      expect(loadHubConfig(null)).toBeNull();
      expect(loadHubConfig(undefined)).toBeNull();
    });

    it('returns null when hub_mode is false', () => {
      writeFileSync(path.join(tmpDir, '.claude-mem-hub.json'), JSON.stringify({
        hub_mode: false,
        default_project: 'test',
        project_patterns: {}
      }));
      expect(loadHubConfig(tmpDir)).toBeNull();
    });

    it('returns null when required fields are missing', () => {
      writeFileSync(path.join(tmpDir, '.claude-mem-hub.json'), JSON.stringify({
        hub_mode: true
      }));
      expect(loadHubConfig(tmpDir)).toBeNull();
    });

    it('loads valid hub config', () => {
      const config = {
        hub_mode: true,
        default_project: 'my-vault',
        project_patterns: {
          'repos/api/core': 'core',
          'repos/web/ui': 'ui'
        }
      };
      writeFileSync(path.join(tmpDir, '.claude-mem-hub.json'), JSON.stringify(config));

      const result = loadHubConfig(tmpDir);
      expect(result).not.toBeNull();
      expect(result!.hub_mode).toBe(true);
      expect(result!.default_project).toBe('my-vault');
      expect(Object.keys(result!.project_patterns)).toHaveLength(2);
    });

    it('caches config and returns same instance on repeated calls', () => {
      const config = {
        hub_mode: true,
        default_project: 'my-vault',
        project_patterns: { 'repos/a': 'proj-a' }
      };
      writeFileSync(path.join(tmpDir, '.claude-mem-hub.json'), JSON.stringify(config));

      const result1 = loadHubConfig(tmpDir);
      const result2 = loadHubConfig(tmpDir);
      expect(result1).toBe(result2); // Same reference (cached)
    });

    it('returns null for invalid JSON', () => {
      writeFileSync(path.join(tmpDir, '.claude-mem-hub.json'), 'not json{');
      expect(loadHubConfig(tmpDir)).toBeNull();
    });
  });

  describe('resolveProjectFromFilePath', () => {
    const hubConfig = {
      hub_mode: true,
      default_project: 'obsidian-vault',
      project_patterns: {
        'repos/api/legal-core': 'legal-core',
        'repos/api/prognosticos': 'prognosticos',
        'repos/data/data-lake': 'data-lake',
        'repos/web/legal-ui': 'legal-ui'
      }
    };

    it('returns default_project for empty file path', () => {
      expect(resolveProjectFromFilePath('', tmpDir, hubConfig)).toBe('obsidian-vault');
    });

    it('matches relative path against patterns', () => {
      const result = resolveProjectFromFilePath(
        path.join(tmpDir, 'repos/api/legal-core/src/main.py'),
        tmpDir,
        hubConfig
      );
      expect(result).toBe('legal-core');
    });

    it('matches deeper nested files', () => {
      const result = resolveProjectFromFilePath(
        path.join(tmpDir, 'repos/data/data-lake/etl/transform.py'),
        tmpDir,
        hubConfig
      );
      expect(result).toBe('data-lake');
    });

    it('returns default for files outside any pattern', () => {
      const result = resolveProjectFromFilePath(
        path.join(tmpDir, 'Areas/legal-core.md'),
        tmpDir,
        hubConfig
      );
      expect(result).toBe('obsidian-vault');
    });

    it('returns default for files in non-matched repos', () => {
      const result = resolveProjectFromFilePath(
        path.join(tmpDir, 'repos/api/unknown-repo/file.py'),
        tmpDir,
        hubConfig
      );
      expect(result).toBe('obsidian-vault');
    });

    it('does longest-prefix match (more specific wins)', () => {
      const configWithOverlap = {
        ...hubConfig,
        project_patterns: {
          ...hubConfig.project_patterns,
          'repos/api': 'api-catch-all',
          'repos/api/legal-core': 'legal-core'
        }
      };

      const result = resolveProjectFromFilePath(
        path.join(tmpDir, 'repos/api/legal-core/src/file.py'),
        tmpDir,
        configWithOverlap
      );
      expect(result).toBe('legal-core');
    });

    it('falls back to catch-all when no specific match', () => {
      const configWithCatchAll = {
        ...hubConfig,
        project_patterns: {
          ...hubConfig.project_patterns,
          'repos/api': 'api-catch-all'
        }
      };

      const result = resolveProjectFromFilePath(
        path.join(tmpDir, 'repos/api/unknown-project/file.py'),
        tmpDir,
        configWithCatchAll
      );
      expect(result).toBe('api-catch-all');
    });

    it('resolves symlinks to match patterns', () => {
      // Create a real directory and a symlink
      const realDir = path.join(tmpDir, 'real-projects', 'legal-core');
      mkdirSync(realDir, { recursive: true });
      writeFileSync(path.join(realDir, 'file.py'), 'content');

      const reposDir = path.join(tmpDir, 'repos', 'api');
      mkdirSync(reposDir, { recursive: true });
      symlinkSync(realDir, path.join(reposDir, 'legal-core'));

      // Access through the symlink path
      const result = resolveProjectFromFilePath(
        path.join(tmpDir, 'repos/api/legal-core/file.py'),
        tmpDir,
        hubConfig
      );
      expect(result).toBe('legal-core');
    });
  });

  describe('getProjectContext (hub mode)', () => {
    it('returns all hub projects in allProjects array', () => {
      const config = {
        hub_mode: true,
        default_project: 'obsidian-vault',
        project_patterns: {
          'repos/api/core': 'core',
          'repos/web/ui': 'ui'
        }
      };
      writeFileSync(path.join(tmpDir, '.claude-mem-hub.json'), JSON.stringify(config));

      const context = getProjectContext(tmpDir);
      expect(context.primary).toBe('obsidian-vault');
      expect(context.parent).toBeNull();
      expect(context.isWorktree).toBe(false);
      expect(context.allProjects).toContain('obsidian-vault');
      expect(context.allProjects).toContain('core');
      expect(context.allProjects).toContain('ui');
    });

    it('deduplicates projects in allProjects', () => {
      const config = {
        hub_mode: true,
        default_project: 'vault',
        project_patterns: {
          'repos/a': 'vault',
          'repos/b': 'other'
        }
      };
      writeFileSync(path.join(tmpDir, '.claude-mem-hub.json'), JSON.stringify(config));

      const context = getProjectContext(tmpDir);
      const vaultCount = context.allProjects.filter(p => p === 'vault').length;
      expect(vaultCount).toBe(1);
    });
  });

  describe('backward compatibility', () => {
    it('getProjectName still returns basename without hub config', () => {
      expect(getProjectName(tmpDir)).toBe(path.basename(tmpDir));
    });

    it('getProjectContext returns single project without hub config', () => {
      const context = getProjectContext(tmpDir);
      expect(context.allProjects).toHaveLength(1);
      expect(context.primary).toBe(path.basename(tmpDir));
    });
  });
});
