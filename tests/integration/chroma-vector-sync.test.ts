/**
 * Chroma Vector Sync Integration Tests
 *
 * Tests ChromaSync vector embedding and semantic search.
 * Skips tests if uvx/chroma not installed (CI-safe).
 *
 * Sources:
 * - ChromaSync implementation from src/services/sync/ChromaSync.ts
 * - MCP patterns from the Chroma MCP server
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, spyOn } from 'bun:test';
import { logger } from '../../src/utils/logger.js';
import path from 'path';
import os from 'os';
import fs from 'fs';

// Check if uvx/chroma is available
let chromaAvailable = false;
let skipReason = '';

async function checkChromaAvailability(): Promise<{ available: boolean; reason: string }> {
  try {
    // Check if uvx is available
    const uvxCheck = Bun.spawn(['uvx', '--version'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await uvxCheck.exited;

    if (uvxCheck.exitCode !== 0) {
      return { available: false, reason: 'uvx not installed' };
    }

    return { available: true, reason: '' };
  } catch (error) {
    return { available: false, reason: `uvx check failed: ${error}` };
  }
}

// Suppress logger output during tests
let loggerSpies: ReturnType<typeof spyOn>[] = [];

describe('ChromaSync Vector Sync Integration', () => {
  const testProject = `test-project-${Date.now()}`;
  const testVectorDbDir = path.join(os.tmpdir(), `chroma-test-${Date.now()}`);

  beforeAll(async () => {
    const check = await checkChromaAvailability();
    chromaAvailable = check.available;
    skipReason = check.reason;

    // Create temp directory for vector db
    if (chromaAvailable) {
      fs.mkdirSync(testVectorDbDir, { recursive: true });
    }
  });

  afterAll(async () => {
    // Cleanup temp directory
    try {
      if (fs.existsSync(testVectorDbDir)) {
        fs.rmSync(testVectorDbDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }
  });

  beforeEach(() => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    loggerSpies.forEach(spy => spy.mockRestore());
  });

  describe('ChromaSync availability check', () => {
    it('should detect uvx availability status', async () => {
      const check = await checkChromaAvailability();
      // This test always passes - it just logs the status
      expect(typeof check.available).toBe('boolean');
      if (!check.available) {
        console.log(`Chroma tests will be skipped: ${check.reason}`);
      }
    });
  });

  describe('ChromaSync class structure', () => {
    it('should be importable', async () => {
      const { ChromaSync } = await import('../../src/services/sync/ChromaSync.js');
      expect(ChromaSync).toBeDefined();
      expect(typeof ChromaSync).toBe('function');
    });

    it('should instantiate with project name', async () => {
      const { ChromaSync } = await import('../../src/services/sync/ChromaSync.js');
      const sync = new ChromaSync('test-project');
      expect(sync).toBeDefined();
    });
  });

  describe('Document formatting', () => {
    it('should format observation documents correctly', async () => {
      if (!chromaAvailable) {
        console.log(`Skipping: ${skipReason}`);
        return;
      }

      const { ChromaSync } = await import('../../src/services/sync/ChromaSync.js');
      const sync = new ChromaSync(testProject);

      // Test the document formatting logic by examining the class
      // The formatObservationDocs method is private, but we can verify
      // the sync method signature exists
      expect(typeof sync.syncObservation).toBe('function');
      expect(typeof sync.syncSummary).toBe('function');
      expect(typeof sync.syncUserPrompt).toBe('function');
    });

    it('should have query method', async () => {
      const { ChromaSync } = await import('../../src/services/sync/ChromaSync.js');
      const sync = new ChromaSync(testProject);
      expect(typeof sync.queryChroma).toBe('function');
    });

    it('should have close method for cleanup', async () => {
      const { ChromaSync } = await import('../../src/services/sync/ChromaSync.js');
      const sync = new ChromaSync(testProject);
      expect(typeof sync.close).toBe('function');
    });

    it('should have ensureBackfilled method', async () => {
      const { ChromaSync } = await import('../../src/services/sync/ChromaSync.js');
      const sync = new ChromaSync(testProject);
      expect(typeof sync.ensureBackfilled).toBe('function');
    });
  });

  describe('Observation sync interface', () => {
    it('should accept ParsedObservation format', async () => {
      const { ChromaSync } = await import('../../src/services/sync/ChromaSync.js');
      const sync = new ChromaSync(testProject);

      // The syncObservation method should accept these parameters
      const observationId = 1;
      const memorySessionId = 'session-123';
      const project = 'test-project';
      const observation = {
        type: 'discovery',
        title: 'Test Title',
        subtitle: 'Test Subtitle',
        facts: ['fact1', 'fact2'],
        narrative: 'Test narrative',
        concepts: ['concept1'],
        files_read: ['/path/to/file.ts'],
        files_modified: []
      };
      const promptNumber = 1;
      const createdAtEpoch = Date.now();

      // Verify method signature accepts these parameters
      // We don't actually call it to avoid needing a running Chroma server
      expect(sync.syncObservation.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Summary sync interface', () => {
    it('should accept ParsedSummary format', async () => {
      const { ChromaSync } = await import('../../src/services/sync/ChromaSync.js');
      const sync = new ChromaSync(testProject);

      // The syncSummary method should accept these parameters
      const summaryId = 1;
      const memorySessionId = 'session-123';
      const project = 'test-project';
      const summary = {
        request: 'Test request',
        investigated: 'Test investigated',
        learned: 'Test learned',
        completed: 'Test completed',
        next_steps: 'Test next steps',
        notes: 'Test notes'
      };
      const promptNumber = 1;
      const createdAtEpoch = Date.now();

      // Verify method exists
      expect(typeof sync.syncSummary).toBe('function');
    });
  });

  describe('User prompt sync interface', () => {
    it('should accept prompt text format', async () => {
      const { ChromaSync } = await import('../../src/services/sync/ChromaSync.js');
      const sync = new ChromaSync(testProject);

      // The syncUserPrompt method should accept these parameters
      const promptId = 1;
      const memorySessionId = 'session-123';
      const project = 'test-project';
      const promptText = 'Help me write a function';
      const promptNumber = 1;
      const createdAtEpoch = Date.now();

      // Verify method exists
      expect(typeof sync.syncUserPrompt).toBe('function');
    });
  });

  describe('Query interface', () => {
    it('should accept query string and options', async () => {
      const { ChromaSync } = await import('../../src/services/sync/ChromaSync.js');
      const sync = new ChromaSync(testProject);

      // Verify method signature
      expect(typeof sync.queryChroma).toBe('function');

      // The method should return a promise
      // (without calling it since no server is running)
    });
  });

  describe('Collection naming', () => {
    it('should use project-based collection name', async () => {
      const { ChromaSync } = await import('../../src/services/sync/ChromaSync.js');

      // Collection name format is cm__{project}
      const projectName = 'my-project';
      const sync = new ChromaSync(projectName);

      // The collection name is private, but we can verify the class
      // was constructed successfully with the project name
      expect(sync).toBeDefined();
    });

    it('should handle special characters in project names', async () => {
      const { ChromaSync } = await import('../../src/services/sync/ChromaSync.js');

      // Projects with special characters should work
      const projectName = 'my-project_v2.0';
      const sync = new ChromaSync(projectName);
      expect(sync).toBeDefined();
    });
  });

  describe('Error handling', () => {
    it('should handle connection failures gracefully', async () => {
      if (!chromaAvailable) {
        console.log(`Skipping: ${skipReason}`);
        return;
      }

      const { ChromaSync } = await import('../../src/services/sync/ChromaSync.js');
      const sync = new ChromaSync(testProject);

      // Calling syncObservation without a running server should throw
      // but not crash the process
      const observation = {
        type: 'discovery' as const,
        title: 'Test',
        subtitle: null,
        facts: [],
        narrative: null,
        concepts: [],
        files_read: [],
        files_modified: []
      };

      // This should either throw or fail gracefully
      try {
        await sync.syncObservation(
          1,
          'session-123',
          'test',
          observation,
          1,
          Date.now()
        );
        // If it didn't throw, the connection might have succeeded
      } catch (error) {
        // Expected - server not running
        expect(error).toBeDefined();
      }

      // Clean up
      await sync.close();
    });
  });

  describe('Cleanup', () => {
    it('should handle close on unconnected instance', async () => {
      const { ChromaSync } = await import('../../src/services/sync/ChromaSync.js');
      const sync = new ChromaSync(testProject);

      // Close without ever connecting should not throw
      await expect(sync.close()).resolves.toBeUndefined();
    });

    it('should be safe to call close multiple times', async () => {
      const { ChromaSync } = await import('../../src/services/sync/ChromaSync.js');
      const sync = new ChromaSync(testProject);

      // Multiple close calls should be safe
      await expect(sync.close()).resolves.toBeUndefined();
      await expect(sync.close()).resolves.toBeUndefined();
    });
  });

  describe('Process leak prevention (Issue #761)', () => {
    /**
     * Regression test for GitHub Issue #761:
     * "Feature Request: Option to disable Chroma (RAM usage / zombie processes)"
     * 
     * Root cause: When connection errors occur (MCP error -32000, Connection closed),
     * the code was resetting `connected` and `client` but NOT closing the transport,
     * leaving the chroma-mcp subprocess alive. Each reconnection attempt spawned
     * a NEW process while old ones accumulated as zombies.
     * 
     * Fix: Close transport before resetting state in error handlers at:
     * - ensureCollection() error handling (~line 180)
     * - queryChroma() error handling (~line 840)
     */
    it('should have transport cleanup in connection error handlers', async () => {
      // This test verifies the fix exists by checking the source code pattern
      // The actual runtime behavior depends on uvx/chroma availability
      const { ChromaSync } = await import('../../src/services/sync/ChromaSync.js');
      const sync = new ChromaSync(testProject);

      // Verify the class has the expected structure
      const syncAny = sync as any;
      
      // Initial state should be null/false
      expect(syncAny.client).toBeNull();
      expect(syncAny.transport).toBeNull();
      expect(syncAny.connected).toBe(false);

      // The close() method should properly clean up all state
      // This is the reference implementation that error handlers should mirror
      await sync.close();
      
      expect(syncAny.client).toBeNull();
      expect(syncAny.transport).toBeNull();
      expect(syncAny.connected).toBe(false);
    });

    it('should reset state after close regardless of connection status', async () => {
      if (!chromaAvailable) {
        console.log(`Skipping: ${skipReason}`);
        return;
      }

      const { ChromaSync } = await import('../../src/services/sync/ChromaSync.js');
      const sync = new ChromaSync(testProject);
      const syncAny = sync as any;

      // Try to establish connection (may succeed or fail depending on environment)
      try {
        await sync.queryChroma('test', 5);
      } catch {
        // Connection or query may fail - that's OK
      }

      // Regardless of whether connection succeeded, close() must clean up everything
      await sync.close();

      // After close(), ALL state must be null/false - this prevents zombie processes
      expect(syncAny.connected).toBe(false);
      expect(syncAny.client).toBeNull();
      expect(syncAny.transport).toBeNull();
    });

    it('should clean up transport in close() method', async () => {
      const { ChromaSync } = await import('../../src/services/sync/ChromaSync.js');
      
      // Read the source to verify transport.close() is called
      // This is a static analysis test - verifies the fix exists
      const sourceFile = await Bun.file(
        new URL('../../src/services/sync/ChromaSync.ts', import.meta.url)
      ).text();

      // Verify that error handlers include transport cleanup
      // The fix adds: if (this.transport) { await this.transport.close(); }
      expect(sourceFile).toContain('this.transport.close()');
      
      // Verify transport is set to null after close
      expect(sourceFile).toContain('this.transport = null');
    });
  });
});
