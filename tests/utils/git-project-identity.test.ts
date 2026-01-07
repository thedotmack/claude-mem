import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import * as child_process from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  normalizeRemoteUrl,
  resolveProjectIdentity,
  clearIdentityCache,
  getGitRoot,
  getGitRemoteOrigin,
  getConfigProjectName,
} from '../../src/utils/git-project-identity.js';

describe('git-project-identity', () => {
  beforeEach(() => {
    clearIdentityCache();
  });

  describe('normalizeRemoteUrl', () => {
    it('should normalize HTTPS URLs', () => {
      expect(normalizeRemoteUrl('https://github.com/user/repo.git')).toBe('github.com/user/repo');
      expect(normalizeRemoteUrl('https://github.com/user/repo')).toBe('github.com/user/repo');
    });

    it('should normalize SSH URLs (git@host:path format)', () => {
      expect(normalizeRemoteUrl('git@github.com:user/repo.git')).toBe('github.com/user/repo');
      expect(normalizeRemoteUrl('git@github.com:user/repo')).toBe('github.com/user/repo');
    });

    it('should normalize SSH URLs (ssh:// format)', () => {
      expect(normalizeRemoteUrl('ssh://git@github.com/user/repo.git')).toBe('github.com/user/repo');
      expect(normalizeRemoteUrl('ssh://git@github.com/user/repo')).toBe('github.com/user/repo');
    });

    it('should handle GitLab subgroups', () => {
      expect(normalizeRemoteUrl('https://gitlab.com/group/subgroup/repo.git')).toBe(
        'gitlab.com/group/subgroup/repo'
      );
      expect(normalizeRemoteUrl('git@gitlab.com:group/subgroup/repo.git')).toBe(
        'gitlab.com/group/subgroup/repo'
      );
    });

    it('should handle self-hosted GitLab', () => {
      expect(normalizeRemoteUrl('https://gitlab.company.com/team/project.git')).toBe(
        'gitlab.company.com/team/project'
      );
    });

    it('should handle Bitbucket URLs', () => {
      expect(normalizeRemoteUrl('git@bitbucket.org:team/repo.git')).toBe('bitbucket.org/team/repo');
    });

    it('should strip .git suffix only once', () => {
      expect(normalizeRemoteUrl('https://github.com/user/repo.git.git')).toBe(
        'github.com/user/repo.git'
      );
    });

    it('should return as-is for unrecognized formats', () => {
      expect(normalizeRemoteUrl('file:///path/to/repo')).toBe('file:///path/to/repo');
    });
  });

  describe('resolveProjectIdentity', () => {
    describe('with real git repo (integration)', () => {
      it('should resolve identity for current working directory', () => {
        // This test runs in the claude-mem repo itself
        const identity = resolveProjectIdentity(process.cwd());

        // Should return a valid identity
        expect(identity.name).toBeTruthy();
        expect(identity.cwd).toBe(process.cwd());
        expect(['config', 'remote', 'git-root', 'folder']).toContain(identity.source);
      });
    });

    describe('cache behavior', () => {
      it('should cache resolved identities', () => {
        const cwd = process.cwd();

        // First call
        const identity1 = resolveProjectIdentity(cwd);

        // Second call should return cached result
        const identity2 = resolveProjectIdentity(cwd);

        expect(identity1).toBe(identity2); // Same object reference
      });

      it('should clear cache with clearIdentityCache()', () => {
        const cwd = process.cwd();

        const identity1 = resolveProjectIdentity(cwd);
        clearIdentityCache();
        const identity2 = resolveProjectIdentity(cwd);

        // Different object (not cached), but same values
        expect(identity1).not.toBe(identity2);
        expect(identity1.name).toBe(identity2.name);
        expect(identity1.source).toBe(identity2.source);
      });
    });

    describe('fallback to folder name', () => {
      it('should use folder basename for non-git directories', () => {
        // Use a temp directory path that definitely isn't a git repo
        const tempPath =
          process.platform === 'win32' ? 'C:\\Windows\\Temp\\not-a-repo' : '/tmp/not-a-repo';

        const identity = resolveProjectIdentity(tempPath);

        expect(identity.name).toBe('not-a-repo');
        expect(identity.source).toBe('folder');
      });

      it('should handle Windows drive roots', () => {
        if (process.platform !== 'win32') return;

        const identity = resolveProjectIdentity('C:\\');

        expect(identity.name).toBe('drive-C');
        expect(identity.source).toBe('folder');
      });
    });
  });

  describe('getConfigProjectName', () => {
    const testDir = path.join(
      process.platform === 'win32' ? 'C:\\Temp' : '/tmp',
      'git-identity-test-' + Date.now()
    );
    const configPath = path.join(testDir, '.claude-mem');

    beforeEach(() => {
      try {
        fs.mkdirSync(testDir, { recursive: true });
      } catch {
        // Directory might already exist
      }
    });

    afterEach(() => {
      try {
        fs.unlinkSync(configPath);
      } catch {
        // File might not exist
      }
      try {
        fs.rmdirSync(testDir);
      } catch {
        // Directory might not be empty or not exist
      }
    });

    it('should return null if config file does not exist', () => {
      const result = getConfigProjectName(testDir);
      expect(result).toBeNull();
    });

    it('should return projectName from valid config', () => {
      fs.writeFileSync(configPath, JSON.stringify({ projectName: 'my-custom-project' }));

      const result = getConfigProjectName(testDir);
      expect(result).toBe('my-custom-project');
    });

    it('should trim whitespace from projectName', () => {
      fs.writeFileSync(configPath, JSON.stringify({ projectName: '  trimmed-name  ' }));

      const result = getConfigProjectName(testDir);
      expect(result).toBe('trimmed-name');
    });

    it('should return null for empty projectName', () => {
      fs.writeFileSync(configPath, JSON.stringify({ projectName: '' }));

      const result = getConfigProjectName(testDir);
      expect(result).toBeNull();
    });

    it('should return null for whitespace-only projectName', () => {
      fs.writeFileSync(configPath, JSON.stringify({ projectName: '   ' }));

      const result = getConfigProjectName(testDir);
      expect(result).toBeNull();
    });

    it('should return null for invalid JSON', () => {
      fs.writeFileSync(configPath, 'not valid json');

      const result = getConfigProjectName(testDir);
      expect(result).toBeNull();
    });

    it('should return null if projectName is not a string', () => {
      fs.writeFileSync(configPath, JSON.stringify({ projectName: 123 }));

      const result = getConfigProjectName(testDir);
      expect(result).toBeNull();
    });

    it('should return null if projectName key is missing', () => {
      fs.writeFileSync(configPath, JSON.stringify({ otherKey: 'value' }));

      const result = getConfigProjectName(testDir);
      expect(result).toBeNull();
    });
  });

  describe('getGitRoot', () => {
    it('should return git root or null for current directory', () => {
      // This test runs in the claude-mem repo (or installed plugin)
      const root = getGitRoot(process.cwd());

      // If it's a git repo, should return a path
      // If not (e.g., installed plugin), returns null - both are valid
      if (root) {
        expect(typeof root).toBe('string');
        expect(root.length).toBeGreaterThan(0);
      } else {
        expect(root).toBeNull();
      }
    });

    it('should return null for non-git directory', () => {
      const tempPath = process.platform === 'win32' ? 'C:\\Windows\\Temp' : '/tmp';
      const root = getGitRoot(tempPath);

      expect(root).toBeNull();
    });
  });

  describe('getGitRemoteOrigin', () => {
    it('should return remote URL or null for current repo', () => {
      // This test runs in the claude-mem repo (or installed plugin)
      const remote = getGitRemoteOrigin(process.cwd());

      // Remote could be null if:
      // - Not a git repo (installed plugin)
      // - Git repo without remotes (local-only)
      // Both are valid cases
      if (remote) {
        expect(typeof remote).toBe('string');
        expect(remote.length).toBeGreaterThan(0);
      } else {
        expect(remote).toBeNull();
      }
    });

    it('should return null for non-git directory', () => {
      const tempPath = process.platform === 'win32' ? 'C:\\Windows\\Temp' : '/tmp';
      const remote = getGitRemoteOrigin(tempPath);

      expect(remote).toBeNull();
    });
  });
});
