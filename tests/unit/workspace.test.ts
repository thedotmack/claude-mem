/**
 * Tests for Workspace Detection and Isolation
 *
 * These tests validate that:
 * 1. Workspace detection correctly identifies which workspace a directory belongs to
 * 2. Workspace names are properly sanitized for filesystem use
 * 3. Data directories are correctly routed per workspace
 * 4. Global fallback works when no workspace roots are configured
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import {
  getWorkspace,
  getWorkspaceDataDir,
  getWorkspaceRoots,
  setWorkspaceRoots,
  clearWorkspaceRootsCache,
  sanitizeWorkspaceName,
  isWorkspaceIsolationEnabled,
  WorkspaceInfo
} from '../../src/utils/workspace.js';

describe('Workspace Detection', () => {
  beforeEach(() => {
    // Clear cache and env before each test
    clearWorkspaceRootsCache();
    delete process.env.CLAUDE_MEM_WORKSPACE_ROOTS;
  });

  afterEach(() => {
    clearWorkspaceRootsCache();
    delete process.env.CLAUDE_MEM_WORKSPACE_ROOTS;
  });

  describe('sanitizeWorkspaceName', () => {
    it('should replace spaces with underscores', () => {
      expect(sanitizeWorkspaceName('DJ Company')).toBe('dj_company');
    });

    it('should handle special characters', () => {
      expect(sanitizeWorkspaceName('Client: ABC/XYZ')).toBe('client_abc_xyz');
    });

    it('should normalize to lowercase', () => {
      expect(sanitizeWorkspaceName('CFD')).toBe('cfd');
    });

    it('should trim leading/trailing underscores', () => {
      expect(sanitizeWorkspaceName('  My Project  ')).toBe('my_project');
    });
  });

  describe('getWorkspace with no configuration', () => {
    it('should return global workspace when no roots configured', () => {
      const result = getWorkspace('/some/random/path');

      expect(result.name).toBe('global');
      expect(result.root).toBeNull();
      expect(result.isolated).toBe(false);
    });

    it('should return global workspace when cwd is null', () => {
      const result = getWorkspace(null);

      expect(result.name).toBe('global');
      expect(result.isolated).toBe(false);
    });
  });

  describe('getWorkspace with configured roots', () => {
    const CFD_ROOT = '/Users/djonatas/projetos/CFD';
    const DJ_ROOT = '/Users/djonatas/projetos/DJ Company';

    beforeEach(() => {
      setWorkspaceRoots([CFD_ROOT, DJ_ROOT]);
    });

    it('should detect CFD workspace for CFD project', () => {
      const result = getWorkspace('/Users/djonatas/projetos/CFD/pulse-back');

      expect(result.name).toBe('cfd');
      expect(result.root).toBe(CFD_ROOT);
      expect(result.isolated).toBe(true);
    });

    it('should detect DJ Company workspace for DJ project', () => {
      const result = getWorkspace('/Users/djonatas/projetos/DJ Company/AssistFlow');

      expect(result.name).toBe('dj_company');
      expect(result.root).toBe(DJ_ROOT);
      expect(result.isolated).toBe(true);
    });

    it('should detect workspace for nested directories', () => {
      const result = getWorkspace('/Users/djonatas/projetos/CFD/pulse-back/src/services');

      expect(result.name).toBe('cfd');
      expect(result.isolated).toBe(true);
    });

    it('should return global for directories outside configured workspaces', () => {
      const result = getWorkspace('/Users/djonatas/projetos/personal/my-project');

      expect(result.name).toBe('global');
      expect(result.root).toBeNull();
      expect(result.isolated).toBe(false);
    });

    it('should return global for completely unrelated paths', () => {
      const result = getWorkspace('/tmp/some-temp-project');

      expect(result.name).toBe('global');
      expect(result.isolated).toBe(false);
    });
  });

  describe('getWorkspaceDataDir', () => {
    const BASE_DIR = '/Users/djonatas/.claude-mem';

    it('should return base directory for global workspace', () => {
      const workspace: WorkspaceInfo = {
        name: 'global',
        root: null,
        isolated: false,
        cwd: '/some/path'
      };

      const result = getWorkspaceDataDir(BASE_DIR, workspace);
      expect(result).toBe(BASE_DIR);
    });

    it('should return workspace subdirectory for isolated workspace', () => {
      const workspace: WorkspaceInfo = {
        name: 'cfd',
        root: '/Users/djonatas/projetos/CFD',
        isolated: true,
        cwd: '/Users/djonatas/projetos/CFD/pulse-back'
      };

      const result = getWorkspaceDataDir(BASE_DIR, workspace);
      expect(result).toBe(path.join(BASE_DIR, 'workspaces', 'cfd'));
    });

    it('should create correct path for DJ Company', () => {
      const workspace: WorkspaceInfo = {
        name: 'dj_company',
        root: '/Users/djonatas/projetos/DJ Company',
        isolated: true,
        cwd: '/Users/djonatas/projetos/DJ Company/AssistFlow'
      };

      const result = getWorkspaceDataDir(BASE_DIR, workspace);
      expect(result).toBe(path.join(BASE_DIR, 'workspaces', 'dj_company'));
    });
  });

  describe('Environment variable configuration', () => {
    it('should load workspace roots from CLAUDE_MEM_WORKSPACE_ROOTS', () => {
      process.env.CLAUDE_MEM_WORKSPACE_ROOTS = '/path/to/client1,/path/to/client2';
      clearWorkspaceRootsCache();

      const roots = getWorkspaceRoots();

      expect(roots).toHaveLength(2);
      expect(roots).toContain(path.resolve('/path/to/client1'));
      expect(roots).toContain(path.resolve('/path/to/client2'));
    });

    it('should handle extra whitespace in env variable', () => {
      process.env.CLAUDE_MEM_WORKSPACE_ROOTS = '  /path/to/client1 , /path/to/client2  ';
      clearWorkspaceRootsCache();

      const roots = getWorkspaceRoots();

      expect(roots).toHaveLength(2);
    });

    it('should handle empty env variable', () => {
      process.env.CLAUDE_MEM_WORKSPACE_ROOTS = '';
      clearWorkspaceRootsCache();

      const roots = getWorkspaceRoots();

      expect(roots).toHaveLength(0);
    });
  });

  describe('isWorkspaceIsolationEnabled', () => {
    it('should return false when no roots configured', () => {
      expect(isWorkspaceIsolationEnabled()).toBe(false);
    });

    it('should return true when roots are configured', () => {
      setWorkspaceRoots(['/some/path']);
      expect(isWorkspaceIsolationEnabled()).toBe(true);
    });
  });
});

describe('Workspace Isolation - Real World Scenario', () => {
  /**
   * This test simulates the exact use case:
   * - CFD and DJ Company are different clients
   * - Projects in CFD should NOT share memory with DJ Company
   * - Each gets its own database
   */

  const CFD_ROOT = '/Users/djonatas/projetos/CFD';
  const DJ_ROOT = '/Users/djonatas/projetos/DJ Company';
  const BASE_DATA_DIR = '/Users/djonatas/.claude-mem';

  beforeEach(() => {
    clearWorkspaceRootsCache();
    setWorkspaceRoots([CFD_ROOT, DJ_ROOT]);
  });

  afterEach(() => {
    clearWorkspaceRootsCache();
  });

  it('should isolate Pulse AI (CFD) from Niina (DJ Company)', () => {
    const pulseWorkspace = getWorkspace('/Users/djonatas/projetos/CFD/pulse-back');
    const niinaWorkspace = getWorkspace('/Users/djonatas/projetos/DJ Company/AssistFlow');

    const pulseDataDir = getWorkspaceDataDir(BASE_DATA_DIR, pulseWorkspace);
    const niinaDataDir = getWorkspaceDataDir(BASE_DATA_DIR, niinaWorkspace);

    // Different workspaces
    expect(pulseWorkspace.name).not.toBe(niinaWorkspace.name);

    // Different data directories
    expect(pulseDataDir).not.toBe(niinaDataDir);

    // Correct paths
    expect(pulseDataDir).toBe('/Users/djonatas/.claude-mem/workspaces/cfd');
    expect(niinaDataDir).toBe('/Users/djonatas/.claude-mem/workspaces/dj_company');
  });

  it('should group all CFD projects together', () => {
    const pulseWorkspace = getWorkspace('/Users/djonatas/projetos/CFD/pulse-back');
    const carusoWorkspace = getWorkspace('/Users/djonatas/projetos/CFD/CRM-full');
    const backofficeWorkspace = getWorkspace('/Users/djonatas/projetos/CFD/backoffice-full');

    // All should be in CFD workspace
    expect(pulseWorkspace.name).toBe('cfd');
    expect(carusoWorkspace.name).toBe('cfd');
    expect(backofficeWorkspace.name).toBe('cfd');

    // All should share the same data directory
    const pulseDataDir = getWorkspaceDataDir(BASE_DATA_DIR, pulseWorkspace);
    const carusoDataDir = getWorkspaceDataDir(BASE_DATA_DIR, carusoWorkspace);
    const backofficeDataDir = getWorkspaceDataDir(BASE_DATA_DIR, backofficeWorkspace);

    expect(pulseDataDir).toBe(carusoDataDir);
    expect(carusoDataDir).toBe(backofficeDataDir);
  });

  it('should group all DJ Company projects together', () => {
    const niinaWorkspace = getWorkspace('/Users/djonatas/projetos/DJ Company/AssistFlow');
    const vyxelWorkspace = getWorkspace('/Users/djonatas/projetos/DJ Company/vyxel');
    const tonyWorkspace = getWorkspace('/Users/djonatas/projetos/DJ Company/tony');

    // All should be in DJ Company workspace
    expect(niinaWorkspace.name).toBe('dj_company');
    expect(vyxelWorkspace.name).toBe('dj_company');
    expect(tonyWorkspace.name).toBe('dj_company');
  });

  it('should handle projects outside configured workspaces', () => {
    const personalWorkspace = getWorkspace('/Users/djonatas/projetos/personal/my-side-project');

    expect(personalWorkspace.name).toBe('global');
    expect(personalWorkspace.isolated).toBe(false);

    const personalDataDir = getWorkspaceDataDir(BASE_DATA_DIR, personalWorkspace);
    expect(personalDataDir).toBe(BASE_DATA_DIR); // Uses global directory
  });
});
