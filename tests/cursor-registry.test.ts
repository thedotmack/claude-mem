import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  readCursorRegistry,
  writeCursorRegistry,
  registerCursorProject,
  unregisterCursorProject
} from '../src/utils/cursor-utils';

/**
 * Tests for Cursor Project Registry functionality
 *
 * These tests validate the file-based registry that tracks which projects
 * have Cursor hooks installed for automatic context updates.
 *
 * The registry is stored at ~/.claude-mem/cursor-projects.json
 */

describe('Cursor Project Registry', () => {
  let tempDir: string;
  let registryFile: string;

  beforeEach(() => {
    // Create unique temp directory for each test
    tempDir = join(tmpdir(), `cursor-registry-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    registryFile = join(tempDir, 'cursor-projects.json');
  });

  afterEach(() => {
    // Clean up temp directory
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('readCursorRegistry', () => {
    it('returns empty object when registry file does not exist', () => {
      const registry = readCursorRegistry(registryFile);
      expect(registry).toEqual({});
    });

    it('returns empty object when registry file is corrupt JSON', () => {
      writeFileSync(registryFile, 'not valid json {{{');
      const registry = readCursorRegistry(registryFile);
      expect(registry).toEqual({});
    });

    it('returns parsed registry when file exists', () => {
      const expected = {
        'my-project': {
          workspacePath: '/home/user/projects/my-project',
          installedAt: '2025-01-01T00:00:00.000Z'
        }
      };
      writeFileSync(registryFile, JSON.stringify(expected));

      const registry = readCursorRegistry(registryFile);
      expect(registry).toEqual(expected);
    });
  });

  describe('registerCursorProject', () => {
    it('creates registry file if it does not exist', () => {
      registerCursorProject(registryFile, 'new-project', '/path/to/project');

      expect(existsSync(registryFile)).toBe(true);
    });

    it('stores project with workspacePath and installedAt', () => {
      const before = Date.now();
      registerCursorProject(registryFile, 'test-project', '/workspace/test');
      const after = Date.now();

      const registry = readCursorRegistry(registryFile);
      expect(registry['test-project']).toBeDefined();
      expect(registry['test-project'].workspacePath).toBe('/workspace/test');

      // Verify installedAt is a valid ISO timestamp within the test window
      const installedAt = new Date(registry['test-project'].installedAt).getTime();
      expect(installedAt).toBeGreaterThanOrEqual(before);
      expect(installedAt).toBeLessThanOrEqual(after);
    });

    it('preserves existing projects when registering new one', () => {
      registerCursorProject(registryFile, 'project-a', '/path/a');
      registerCursorProject(registryFile, 'project-b', '/path/b');

      const registry = readCursorRegistry(registryFile);
      expect(Object.keys(registry)).toHaveLength(2);
      expect(registry['project-a'].workspacePath).toBe('/path/a');
      expect(registry['project-b'].workspacePath).toBe('/path/b');
    });

    it('overwrites existing project with same name', () => {
      registerCursorProject(registryFile, 'my-project', '/old/path');
      registerCursorProject(registryFile, 'my-project', '/new/path');

      const registry = readCursorRegistry(registryFile);
      expect(Object.keys(registry)).toHaveLength(1);
      expect(registry['my-project'].workspacePath).toBe('/new/path');
    });

    it('handles special characters in project name', () => {
      const projectName = 'my-project_v2.0 (beta)';
      registerCursorProject(registryFile, projectName, '/path/to/project');

      const registry = readCursorRegistry(registryFile);
      expect(registry[projectName]).toBeDefined();
      expect(registry[projectName].workspacePath).toBe('/path/to/project');
    });
  });

  describe('unregisterCursorProject', () => {
    it('removes specified project from registry', () => {
      registerCursorProject(registryFile, 'project-a', '/path/a');
      registerCursorProject(registryFile, 'project-b', '/path/b');

      unregisterCursorProject(registryFile, 'project-a');

      const registry = readCursorRegistry(registryFile);
      expect(registry['project-a']).toBeUndefined();
      expect(registry['project-b']).toBeDefined();
    });

    it('does nothing when unregistering non-existent project', () => {
      registerCursorProject(registryFile, 'existing', '/path');

      // Should not throw
      unregisterCursorProject(registryFile, 'non-existent');

      const registry = readCursorRegistry(registryFile);
      expect(registry['existing']).toBeDefined();
    });

    it('handles unregister when registry file does not exist', () => {
      // Should not throw even when file doesn't exist
      unregisterCursorProject(registryFile, 'any-project');

      // File should not be created by unregister
      expect(existsSync(registryFile)).toBe(false);
    });
  });

  describe('registry format validation', () => {
    it('stores registry as pretty-printed JSON', () => {
      registerCursorProject(registryFile, 'test', '/path');

      const content = readFileSync(registryFile, 'utf-8');
      // Should be indented (pretty-printed)
      expect(content).toContain('\n');
      expect(content).toContain('  ');
    });

    it('registry file is valid JSON that can be read by other tools', () => {
      registerCursorProject(registryFile, 'project-1', '/path/1');
      registerCursorProject(registryFile, 'project-2', '/path/2');

      // Read raw and parse with JSON.parse (not our helper)
      const content = readFileSync(registryFile, 'utf-8');
      const parsed = JSON.parse(content);

      expect(parsed).toHaveProperty('project-1');
      expect(parsed).toHaveProperty('project-2');
    });
  });
});
