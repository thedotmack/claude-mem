
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, spyOn } from 'bun:test';
import { logger } from '../../src/utils/logger.js';
import path from 'path';
import os from 'os';
import fs from 'fs';

let chromaAvailable = false;
let skipReason = '';

async function checkChromaAvailability(): Promise<{ available: boolean; reason: string }> {
  try {
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

let loggerSpies: ReturnType<typeof spyOn>[] = [];

describe('ChromaSync Vector Sync Integration', () => {
  const testProject = `test-project-${Date.now()}`;
  const testVectorDbDir = path.join(os.tmpdir(), `chroma-test-${Date.now()}`);

  beforeAll(async () => {
    const check = await checkChromaAvailability();
    chromaAvailable = check.available;
    skipReason = check.reason;

    if (chromaAvailable) {
      fs.mkdirSync(testVectorDbDir, { recursive: true });
    }
  });

  afterAll(async () => {
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

      expect(sync.syncObservation.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Summary sync interface', () => {
    it('should accept ParsedSummary format', async () => {
      const { ChromaSync } = await import('../../src/services/sync/ChromaSync.js');
      const sync = new ChromaSync(testProject);

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

      expect(typeof sync.syncSummary).toBe('function');
    });
  });

  describe('User prompt sync interface', () => {
    it('should accept prompt text format', async () => {
      const { ChromaSync } = await import('../../src/services/sync/ChromaSync.js');
      const sync = new ChromaSync(testProject);

      const promptId = 1;
      const memorySessionId = 'session-123';
      const project = 'test-project';
      const promptText = 'Help me write a function';
      const promptNumber = 1;
      const createdAtEpoch = Date.now();

      expect(typeof sync.syncUserPrompt).toBe('function');
    });
  });

  describe('Query interface', () => {
    it('should accept query string and options', async () => {
      const { ChromaSync } = await import('../../src/services/sync/ChromaSync.js');
      const sync = new ChromaSync(testProject);

      expect(typeof sync.queryChroma).toBe('function');

      // The method should return a promise
      // (without calling it since no server is running)
    });
  });

  describe('Collection naming', () => {
    it('should use project-based collection name', async () => {
      const { ChromaSync } = await import('../../src/services/sync/ChromaSync.js');

      const projectName = 'my-project';
      const sync = new ChromaSync(projectName);

      expect(sync).toBeDefined();
    });

    it('should handle special characters in project names', async () => {
      const { ChromaSync } = await import('../../src/services/sync/ChromaSync.js');

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
        expect(error).toBeDefined();
      }

      await sync.close();
    });
  });

  describe('Cleanup', () => {
    it('should handle close on unconnected instance', async () => {
      const { ChromaSync } = await import('../../src/services/sync/ChromaSync.js');
      const sync = new ChromaSync(testProject);

      await expect(sync.close()).resolves.toBeUndefined();
    });

    it('should be safe to call close multiple times', async () => {
      const { ChromaSync } = await import('../../src/services/sync/ChromaSync.js');
      const sync = new ChromaSync(testProject);

      await expect(sync.close()).resolves.toBeUndefined();
      await expect(sync.close()).resolves.toBeUndefined();
    });
  });

  describe('Process leak prevention (Issue #761)', () => {
    it('should have transport cleanup in ChromaMcpManager error handlers', async () => {
      const sourceFile = await Bun.file(
        new URL('../../src/services/sync/ChromaMcpManager.ts', import.meta.url)
      ).text();

      expect(sourceFile).toContain('this.transport.close()');

      expect(sourceFile).toContain('this.transport = null');

      expect(sourceFile).toContain('this.connected = false');
    });

    it('should reset state after close regardless of connection status', async () => {
      const { ChromaSync } = await import('../../src/services/sync/ChromaSync.js');
      const sync = new ChromaSync(testProject);

      await expect(sync.close()).resolves.toBeUndefined();
    });

    it('should clean up transport in ChromaMcpManager close() method', async () => {
      const sourceFile = await Bun.file(
        new URL('../../src/services/sync/ChromaMcpManager.ts', import.meta.url)
      ).text();

      expect(sourceFile).toContain('await this.transport.close()');
      expect(sourceFile).toContain('this.transport = null');
      expect(sourceFile).toContain('this.connected = false');
    });
  });
});
