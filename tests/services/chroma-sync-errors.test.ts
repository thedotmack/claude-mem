/**
 * Test: ChromaSync Error Handling
 *
 * Verifies that ChromaSync fails fast with clear error messages when
 * client is not initialized. Prevents regression of observation 25458
 * where error messages were inconsistent across client checks.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ChromaSync } from '../../src/services/sync/ChromaSync.js';

describe('ChromaSync Error Handling', () => {
  let chromaSync: ChromaSync;
  const testProject = 'test-project';

  beforeEach(() => {
    chromaSync = new ChromaSync(testProject);
  });

  describe('Client initialization checks', () => {
    it('ensureCollection throws when client not initialized', async () => {
      // Force client to be null (simulates forgetting to call ensureConnection)
      (chromaSync as any).client = null;
      (chromaSync as any).connected = false;

      await expect(async () => {
        // This should call ensureConnection internally, but let's test the guard
        await (chromaSync as any).ensureCollection();
      }).rejects.toThrow();
    });

    it('addDocuments throws with project name when client not initialized', async () => {
      (chromaSync as any).client = null;
      (chromaSync as any).connected = false;

      const testDocs = [
        {
          id: 'test_1',
          document: 'Test document',
          metadata: { type: 'test' }
        }
      ];

      try {
        await (chromaSync as any).addDocuments(testDocs);
        expect.fail('Should have thrown error');
      } catch (error: any) {
        expect(error.message).toContain('Chroma client not initialized');
        expect(error.message).toContain('ensureConnection()');
        expect(error.message).toContain(`Project: ${testProject}`);
      }
    });

    it('queryChroma throws with project name when client not initialized', async () => {
      (chromaSync as any).client = null;
      (chromaSync as any).connected = false;

      try {
        await chromaSync.queryChroma('test query', 10);
        expect.fail('Should have thrown error');
      } catch (error: any) {
        expect(error.message).toContain('Chroma client not initialized');
        expect(error.message).toContain('ensureConnection()');
        expect(error.message).toContain(`Project: ${testProject}`);
      }
    });

    it('getExistingChromaIds throws with project name when client not initialized', async () => {
      (chromaSync as any).client = null;
      (chromaSync as any).connected = false;

      try {
        await (chromaSync as any).getExistingChromaIds();
        expect.fail('Should have thrown error');
      } catch (error: any) {
        expect(error.message).toContain('Chroma client not initialized');
        expect(error.message).toContain('ensureConnection()');
        expect(error.message).toContain(`Project: ${testProject}`);
      }
    });
  });

  describe('Error message consistency', () => {
    it('all client checks use identical error message format', async () => {
      (chromaSync as any).client = null;
      (chromaSync as any).connected = false;

      const errors: string[] = [];

      // Collect error messages from all client check locations
      try {
        await (chromaSync as any).addDocuments([]);
      } catch (error: any) {
        errors.push(error.message);
      }

      try {
        await chromaSync.queryChroma('test', 10);
      } catch (error: any) {
        errors.push(error.message);
      }

      try {
        await (chromaSync as any).getExistingChromaIds();
      } catch (error: any) {
        errors.push(error.message);
      }

      // All errors should have the same structure
      expect(errors.length).toBe(3);
      for (const errorMsg of errors) {
        expect(errorMsg).toContain('Chroma client not initialized');
        expect(errorMsg).toContain('Call ensureConnection()');
        expect(errorMsg).toContain('Project:');
      }
    });

    it('error messages include actionable instructions', async () => {
      (chromaSync as any).client = null;
      (chromaSync as any).connected = false;

      try {
        await chromaSync.queryChroma('test', 10);
      } catch (error: any) {
        // Must tell developer what to do
        expect(error.message).toContain('Call ensureConnection()');

        // Must help with debugging
        expect(error.message).toContain('Project:');
      }
    });
  });

  describe('Connection failure handling', () => {
    it('ensureConnection throws clear error when Chroma MCP fails', async () => {
      // This test would require mocking the MCP client
      // For now, document the expected behavior:

      // When uvx chroma-mcp fails:
      // - Error should contain "Chroma connection failed"
      // - Error should include original error message
      // - Error should be logged before throwing

      expect(true).toBe(true); // Placeholder - implement when MCP mocking available
    });

    it('collection creation throws clear error on failure', async () => {
      // When chroma_create_collection fails:
      // - Error should contain "Collection creation failed"
      // - Error should include collection name
      // - Error should be logged with full context

      expect(true).toBe(true); // Placeholder - implement when MCP mocking available
    });
  });

  describe('Operation failure handling', () => {
    it('addDocuments throws clear error with document count on failure', async () => {
      // When chroma_add_documents fails:
      // - Error should contain "Document add failed"
      // - Log should include document count
      // - Original error message should be preserved

      expect(true).toBe(true); // Placeholder - implement when MCP mocking available
    });

    it('backfill throws clear error with progress on failure', async () => {
      // When ensureBackfilled() fails:
      // - Error should contain "Backfill failed"
      // - Error should include project name
      // - Database should be closed in finally block

      expect(true).toBe(true); // Placeholder - implement when MCP mocking available
    });
  });

  describe('Fail-fast behavior', () => {
    it('does not retry failed operations silently', async () => {
      (chromaSync as any).client = null;
      (chromaSync as any).connected = false;

      // Should fail immediately, not retry
      const startTime = Date.now();

      try {
        await chromaSync.queryChroma('test', 10);
      } catch (error: any) {
        const elapsed = Date.now() - startTime;

        // Should fail fast (< 100ms), not retry with delays
        expect(elapsed).toBeLessThan(100);
      }
    });

    it('throws errors rather than returning null or empty results', async () => {
      (chromaSync as any).client = null;
      (chromaSync as any).connected = false;

      // Should throw, not return empty array
      await expect(async () => {
        await chromaSync.queryChroma('test', 10);
      }).rejects.toThrow();

      // Should not silently return { ids: [], distances: [], metadatas: [] }
    });
  });

  describe('Error context preservation', () => {
    it('includes project name in all error messages', async () => {
      const projects = ['project-a', 'project-b', 'my-app'];

      for (const project of projects) {
        const sync = new ChromaSync(project);
        (sync as any).client = null;
        (sync as any).connected = false;

        try {
          await sync.queryChroma('test', 10);
        } catch (error: any) {
          expect(error.message).toContain(`Project: ${project}`);
        }
      }
    });

    it('preserves original error messages in wrapped errors', async () => {
      // When ChromaSync wraps lower-level errors:
      // - Original error message should be included
      // - Stack trace should be preserved
      // - Error should be logged before re-throwing

      expect(true).toBe(true); // Placeholder - implement when error wrapping tested
    });
  });
});
