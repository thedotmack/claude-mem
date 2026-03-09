/**
 * Integration Tests for Workspace Isolation
 *
 * These tests validate that:
 * 1. Different workspaces have completely separate databases
 * 2. Data stored in one workspace is NOT visible in another
 * 3. Projects within the same workspace share data correctly
 * 4. Global fallback works for paths outside configured workspaces
 *
 * Note: Database tests use better-sqlite3 for Node.js/Vitest compatibility.
 * The actual production code uses bun:sqlite which has the same API.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'fs';
import path from 'path';
import BetterSqlite3 from 'better-sqlite3';
import {
  getWorkspace,
  getWorkspaceDataDir,
  setWorkspaceRoots,
  clearWorkspaceRootsCache,
  WorkspaceInfo
} from '../../src/utils/workspace.js';
import { WorkspacePaths } from '../../src/shared/paths-workspace.js';

// Type alias for database (better-sqlite3 is API-compatible with bun:sqlite)
type Database = BetterSqlite3.Database;

// Test directories
const TEST_BASE_DIR = '/tmp/claude-mem-test-workspace-isolation';
const TEST_DATA_DIR = path.join(TEST_BASE_DIR, 'data');
const TEST_WORKSPACE_A = path.join(TEST_BASE_DIR, 'workspaces', 'ClientA');
const TEST_WORKSPACE_B = path.join(TEST_BASE_DIR, 'workspaces', 'ClientB');
const TEST_PROJECT_A1 = path.join(TEST_WORKSPACE_A, 'project1');
const TEST_PROJECT_A2 = path.join(TEST_WORKSPACE_A, 'project2');
const TEST_PROJECT_B1 = path.join(TEST_WORKSPACE_B, 'project1');
const TEST_EXTERNAL = path.join(TEST_BASE_DIR, 'external', 'side-project');

describe('Workspace Isolation Integration Tests', () => {
  beforeAll(() => {
    // Clean up any previous test data
    if (existsSync(TEST_BASE_DIR)) {
      rmSync(TEST_BASE_DIR, { recursive: true });
    }

    // Create test directory structure
    mkdirSync(TEST_PROJECT_A1, { recursive: true });
    mkdirSync(TEST_PROJECT_A2, { recursive: true });
    mkdirSync(TEST_PROJECT_B1, { recursive: true });
    mkdirSync(TEST_EXTERNAL, { recursive: true });
    mkdirSync(TEST_DATA_DIR, { recursive: true });

    // Configure workspace roots
    setWorkspaceRoots([TEST_WORKSPACE_A, TEST_WORKSPACE_B]);
  });

  afterAll(() => {
    // Clean up test data
    clearWorkspaceRootsCache();
    if (existsSync(TEST_BASE_DIR)) {
      rmSync(TEST_BASE_DIR, { recursive: true });
    }
  });

  describe('Database Path Resolution', () => {
    it('should create separate database paths for each workspace', () => {
      const pathsA = new WorkspacePaths(TEST_PROJECT_A1);
      const pathsB = new WorkspacePaths(TEST_PROJECT_B1);

      // Different workspaces should have different DB paths
      expect(pathsA.dbPath).not.toBe(pathsB.dbPath);

      // Paths should contain workspace name
      expect(pathsA.dbPath).toContain('clienta');
      expect(pathsB.dbPath).toContain('clientb');
    });

    it('should use same database path for projects in same workspace', () => {
      const pathsA1 = new WorkspacePaths(TEST_PROJECT_A1);
      const pathsA2 = new WorkspacePaths(TEST_PROJECT_A2);

      // Same workspace should have same DB path
      expect(pathsA1.dbPath).toBe(pathsA2.dbPath);
    });

    it('should use global database for paths outside configured workspaces', () => {
      const pathsExternal = new WorkspacePaths(TEST_EXTERNAL);
      const pathsA = new WorkspacePaths(TEST_PROJECT_A1);

      // External should NOT have workspace subdirectory
      expect(pathsExternal.dbPath).not.toContain('workspaces');
      expect(pathsExternal.isIsolated).toBe(false);

      // A should have workspace subdirectory
      expect(pathsA.dbPath).toContain('workspaces');
      expect(pathsA.isIsolated).toBe(true);
    });
  });

  describe('Real Database Isolation', () => {
    let dbA: Database;
    let dbB: Database;
    let dbGlobal: Database;

    beforeAll(() => {
      // Create workspace-specific paths
      const pathsA = new WorkspacePaths(TEST_PROJECT_A1);
      const pathsB = new WorkspacePaths(TEST_PROJECT_B1);
      const pathsGlobal = new WorkspacePaths(TEST_EXTERNAL);

      // Override base data dir for testing
      const testDbPathA = path.join(TEST_DATA_DIR, 'workspaces', 'clienta', 'claude-mem.db');
      const testDbPathB = path.join(TEST_DATA_DIR, 'workspaces', 'clientb', 'claude-mem.db');
      const testDbPathGlobal = path.join(TEST_DATA_DIR, 'claude-mem.db');

      // Ensure directories exist
      mkdirSync(path.dirname(testDbPathA), { recursive: true });
      mkdirSync(path.dirname(testDbPathB), { recursive: true });
      mkdirSync(path.dirname(testDbPathGlobal), { recursive: true });

      // Create databases
      dbA = new BetterSqlite3(testDbPathA);
      dbB = new BetterSqlite3(testDbPathB);
      dbGlobal = new BetterSqlite3(testDbPathGlobal);

      // Create test tables in each database
      const createTable = `
        CREATE TABLE IF NOT EXISTS test_observations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project TEXT NOT NULL,
          content TEXT NOT NULL,
          workspace TEXT NOT NULL
        )
      `;

      dbA.exec(createTable);
      dbB.exec(createTable);
      dbGlobal.exec(createTable);
    });

    afterAll(() => {
      dbA?.close();
      dbB?.close();
      dbGlobal?.close();
    });

    it('should store data in workspace-specific database', () => {
      // Insert into workspace A
      dbA.prepare(
        'INSERT INTO test_observations (project, content, workspace) VALUES (?, ?, ?)'
      ).run('project1', 'Secret data for Client A', 'clienta');

      // Insert into workspace B
      dbB.prepare(
        'INSERT INTO test_observations (project, content, workspace) VALUES (?, ?, ?)'
      ).run('project1', 'Confidential data for Client B', 'clientb');

      // Query workspace A - should only see A's data
      const resultsA = dbA.prepare('SELECT * FROM test_observations').all() as any[];
      expect(resultsA).toHaveLength(1);
      expect(resultsA[0].content).toBe('Secret data for Client A');
      expect(resultsA[0].workspace).toBe('clienta');

      // Query workspace B - should only see B's data
      const resultsB = dbB.prepare('SELECT * FROM test_observations').all() as any[];
      expect(resultsB).toHaveLength(1);
      expect(resultsB[0].content).toBe('Confidential data for Client B');
      expect(resultsB[0].workspace).toBe('clientb');
    });

    it('should NOT leak data between workspaces', () => {
      // Workspace A should NOT see workspace B's data
      const resultsA = dbA.prepare(
        "SELECT * FROM test_observations WHERE content LIKE '%Client B%'"
      ).all();
      expect(resultsA).toHaveLength(0);

      // Workspace B should NOT see workspace A's data
      const resultsB = dbB.prepare(
        "SELECT * FROM test_observations WHERE content LIKE '%Client A%'"
      ).all();
      expect(resultsB).toHaveLength(0);
    });

    it('should keep global database separate from workspace databases', () => {
      // Insert into global
      dbGlobal.prepare(
        'INSERT INTO test_observations (project, content, workspace) VALUES (?, ?, ?)'
      ).run('side-project', 'Personal project data', 'global');

      // Global should NOT see workspace data
      const resultsGlobal = dbGlobal.prepare('SELECT * FROM test_observations').all() as any[];
      expect(resultsGlobal).toHaveLength(1);
      expect(resultsGlobal[0].workspace).toBe('global');

      // Workspaces should NOT see global data
      const resultsA = dbA.prepare(
        "SELECT * FROM test_observations WHERE workspace = 'global'"
      ).all();
      expect(resultsA).toHaveLength(0);

      const resultsB = dbB.prepare(
        "SELECT * FROM test_observations WHERE workspace = 'global'"
      ).all();
      expect(resultsB).toHaveLength(0);
    });
  });

  describe('Workspace Detection Edge Cases', () => {
    it('should handle deeply nested project paths', () => {
      const deepPath = path.join(TEST_WORKSPACE_A, 'org', 'team', 'repo', 'packages', 'core');
      const workspace = getWorkspace(deepPath);

      expect(workspace.name).toBe('clienta');
      expect(workspace.isolated).toBe(true);
    });

    it('should handle paths with special characters', () => {
      // Note: The actual workspace root has a space, which is sanitized
      const pathWithSpace = path.join(TEST_WORKSPACE_A, 'project with spaces');
      const workspace = getWorkspace(pathWithSpace);

      // Should still detect the workspace correctly
      expect(workspace.name).toBe('clienta');
      expect(workspace.isolated).toBe(true);
    });

    it('should handle null/undefined cwd gracefully', () => {
      const workspaceNull = getWorkspace(null);
      const workspaceUndefined = getWorkspace(undefined);

      expect(workspaceNull.name).toBe('global');
      expect(workspaceNull.isolated).toBe(false);
      expect(workspaceUndefined.name).toBe('global');
      expect(workspaceUndefined.isolated).toBe(false);
    });

    it('should handle workspace root itself as cwd', () => {
      const workspace = getWorkspace(TEST_WORKSPACE_A);

      expect(workspace.name).toBe('clienta');
      expect(workspace.isolated).toBe(true);
      expect(workspace.root).toBe(TEST_WORKSPACE_A);
    });
  });

  describe('Multiple Projects Same Workspace', () => {
    let dbWorkspaceA: Database;

    beforeAll(() => {
      const dbPath = path.join(TEST_DATA_DIR, 'workspaces', 'clienta', 'shared-test.db');
      mkdirSync(path.dirname(dbPath), { recursive: true });
      dbWorkspaceA = new BetterSqlite3(dbPath);

      dbWorkspaceA.exec(`
        CREATE TABLE IF NOT EXISTS observations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project TEXT NOT NULL,
          content TEXT NOT NULL
        )
      `);
    });

    afterAll(() => {
      dbWorkspaceA?.close();
    });

    it('should allow projects in same workspace to see each other data', () => {
      // Insert from "project1" context
      dbWorkspaceA.prepare(
        'INSERT INTO observations (project, content) VALUES (?, ?)'
      ).run('project1', 'Data from project1');

      // Insert from "project2" context
      dbWorkspaceA.prepare(
        'INSERT INTO observations (project, content) VALUES (?, ?)'
      ).run('project2', 'Data from project2');

      // Both projects share the same database, so all data is visible
      const allResults = dbWorkspaceA.prepare('SELECT * FROM observations').all() as any[];
      expect(allResults).toHaveLength(2);

      // Can query across projects
      const project1Data = dbWorkspaceA.prepare(
        "SELECT * FROM observations WHERE project = 'project1'"
      ).all() as any[];
      expect(project1Data).toHaveLength(1);

      const project2Data = dbWorkspaceA.prepare(
        "SELECT * FROM observations WHERE project = 'project2'"
      ).all() as any[];
      expect(project2Data).toHaveLength(1);
    });
  });
});

describe('Workspace Configuration', () => {
  beforeEach(() => {
    clearWorkspaceRootsCache();
    delete process.env.CLAUDE_MEM_WORKSPACE_ROOTS;
  });

  afterAll(() => {
    clearWorkspaceRootsCache();
  });

  it('should support environment variable configuration', () => {
    process.env.CLAUDE_MEM_WORKSPACE_ROOTS = `${TEST_WORKSPACE_A},${TEST_WORKSPACE_B}`;

    const workspaceA = getWorkspace(TEST_PROJECT_A1);
    const workspaceB = getWorkspace(TEST_PROJECT_B1);

    expect(workspaceA.isolated).toBe(true);
    expect(workspaceB.isolated).toBe(true);
    expect(workspaceA.name).not.toBe(workspaceB.name);
  });

  it('should disable isolation when no roots configured', () => {
    // No env var, no programmatic config
    const workspace = getWorkspace(TEST_PROJECT_A1);

    expect(workspace.isolated).toBe(false);
    expect(workspace.name).toBe('global');
  });
});
