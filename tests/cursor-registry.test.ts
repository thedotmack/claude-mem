import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { DATA_DIR } from '../src/shared/paths';
import {
  readCursorRegistry,
  registerCursorProject,
  unregisterCursorProject
} from '../src/services/integrations/CursorHooksInstaller';

// The registry path is bound to DATA_DIR at import time. tests/preload.ts
// already pins CLAUDE_MEM_DATA_DIR at a per-run temp dir, so this only has to
// clear the file between cases.
const registryFile = join(DATA_DIR, 'cursor-projects.json');

describe('Cursor Project Registry', () => {
  beforeEach(() => {
    rmSync(registryFile, { force: true });
  });

  afterEach(() => {
    rmSync(registryFile, { force: true });
  });

  describe('readCursorRegistry', () => {
    it('returns empty object when registry file does not exist', () => {
      const registry = readCursorRegistry();
      expect(registry).toEqual({});
    });

    it('returns empty object when registry file is corrupt JSON', () => {
      writeFileSync(registryFile, 'not valid json {{{');
      const registry = readCursorRegistry();
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

      const registry = readCursorRegistry();
      expect(registry).toEqual(expected);
    });
  });

  describe('registerCursorProject', () => {
    it('creates registry file if it does not exist', () => {
      registerCursorProject('new-project', '/path/to/project');

      expect(existsSync(registryFile)).toBe(true);
    });

    it('stores project with workspacePath and installedAt', () => {
      const before = Date.now();
      registerCursorProject('test-project', '/workspace/test');
      const after = Date.now();

      const registry = readCursorRegistry();
      expect(registry['test-project']).toBeDefined();
      expect(registry['test-project'].workspacePath).toBe('/workspace/test');

      const installedAt = new Date(registry['test-project'].installedAt).getTime();
      expect(installedAt).toBeGreaterThanOrEqual(before);
      expect(installedAt).toBeLessThanOrEqual(after);
    });

    it('preserves existing projects when registering new one', () => {
      registerCursorProject('project-a', '/path/a');
      registerCursorProject('project-b', '/path/b');

      const registry = readCursorRegistry();
      expect(Object.keys(registry)).toHaveLength(2);
      expect(registry['project-a'].workspacePath).toBe('/path/a');
      expect(registry['project-b'].workspacePath).toBe('/path/b');
    });

    it('overwrites existing project with same name', () => {
      registerCursorProject('my-project', '/old/path');
      registerCursorProject('my-project', '/new/path');

      const registry = readCursorRegistry();
      expect(Object.keys(registry)).toHaveLength(1);
      expect(registry['my-project'].workspacePath).toBe('/new/path');
    });

    it('handles special characters in project name', () => {
      const projectName = 'my-project_v2.0 (beta)';
      registerCursorProject(projectName, '/path/to/project');

      const registry = readCursorRegistry();
      expect(registry[projectName]).toBeDefined();
      expect(registry[projectName].workspacePath).toBe('/path/to/project');
    });
  });

  describe('unregisterCursorProject', () => {
    it('removes specified project from registry', () => {
      registerCursorProject('project-a', '/path/a');
      registerCursorProject('project-b', '/path/b');

      unregisterCursorProject('project-a');

      const registry = readCursorRegistry();
      expect(registry['project-a']).toBeUndefined();
      expect(registry['project-b']).toBeDefined();
    });

    it('does nothing when unregistering non-existent project', () => {
      registerCursorProject('existing', '/path');

      unregisterCursorProject('non-existent');

      const registry = readCursorRegistry();
      expect(registry['existing']).toBeDefined();
    });

    it('handles unregister when registry file does not exist', () => {
      unregisterCursorProject('any-project');

      expect(existsSync(registryFile)).toBe(false);
    });
  });

  describe('registry format validation', () => {
    it('stores registry as pretty-printed JSON', () => {
      registerCursorProject('test', '/path');

      const content = readFileSync(registryFile, 'utf-8');
      expect(content).toContain('\n');
      expect(content).toContain('  ');
    });

    it('registry file is valid JSON that can be read by other tools', () => {
      registerCursorProject('project-1', '/path/1');
      registerCursorProject('project-2', '/path/2');

      const content = readFileSync(registryFile, 'utf-8');
      const parsed = JSON.parse(content);

      expect(parsed).toHaveProperty('project-1');
      expect(parsed).toHaveProperty('project-2');
    });
  });
});
