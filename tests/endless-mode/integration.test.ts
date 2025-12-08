/**
 * Endless Mode v7.1 - Integration Tests
 *
 * Full end-to-end tests with real worker service and database.
 * These tests are slower but validate the complete SSE flow.
 *
 * Prerequisites:
 * - Worker service must be running (pm2 start claude-mem-worker)
 * - Database must be accessible at ~/.claude-mem/claude-mem.db
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { EventSource } from 'eventsource';

const WORKER_PORT = 37777;
const TEST_SESSION_ID = `test-endless-mode-${Date.now()}`;

describe('Endless Mode v7.1 - Integration Tests', () => {
  beforeAll(async () => {
    // Verify worker is running
    try {
      const response = await fetch(`http://127.0.0.1:${WORKER_PORT}/health`);
      if (!response.ok) {
        throw new Error('Worker health check failed');
      }
    } catch (error) {
      throw new Error(
        `Worker not running on port ${WORKER_PORT}. Start it with: pm2 start claude-mem-worker`
      );
    }
  });

  describe('Full SSE Flow', () => {
    it('should complete full observation lifecycle with SSE', async () => {
      // Step 1: Create a test observation
      const observationPayload = {
        claudeSessionId: TEST_SESSION_ID,
        tool_name: 'Bash',
        tool_input: { command: 'git status', description: 'Check git status' },
        tool_response: { stdout: 'On branch main\nnothing to commit', exit_code: 0 },
        cwd: '/project',
        toolUseId: `toolu_integration_${Date.now()}`
      };

      const createResponse = await fetch(`http://127.0.0.1:${WORKER_PORT}/api/sessions/observations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(observationPayload)
      });

      expect(createResponse.ok).toBe(true);
      const createResult = await createResponse.json();
      // Status can be 'queued' or 'skipped' (if privacy tags detected)
      expect(['queued', 'skipped']).toContain(createResult.status);

      // Step 2: Subscribe to SSE and wait for queueDepth: 0
      const sseCompleted = await new Promise<boolean>((resolve, reject) => {
        const timeout = setTimeout(() => {
          eventSource.close();
          reject(new Error('SSE timeout after 30 seconds'));
        }, 30000);

        const eventSource = new EventSource(`http://127.0.0.1:${WORKER_PORT}/stream`);

        eventSource.addEventListener('processing_status', (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.queueDepth === 0) {
              clearTimeout(timeout);
              eventSource.close();
              resolve(true);
            }
          } catch (error) {
            // Ignore malformed events
          }
        });

        eventSource.onerror = (error) => {
          clearTimeout(timeout);
          eventSource.close();
          reject(new Error('SSE connection error'));
        };
      });

      expect(sseCompleted).toBe(true);

      // Step 3: Fetch observations for the tool_use_id
      const fetchResponse = await fetch(
        `http://127.0.0.1:${WORKER_PORT}/api/sessions/observations-for-tool-use/${observationPayload.toolUseId}`
      );

      expect(fetchResponse.ok).toBe(true);
      const fetchResult = await fetchResponse.json();

      // Verify observations were created
      expect(fetchResult.observations).toBeDefined();
      expect(Array.isArray(fetchResult.observations)).toBe(true);

      // In a real scenario, observations would be created by the SDK agent
      // For this test, we verify the endpoint works and returns the correct structure
    }, 35000); // 35 second timeout for this slow test

    it('should handle concurrent SSE connections', async () => {
      // Create 3 observations simultaneously
      const toolUseIds = [
        `toolu_concurrent_1_${Date.now()}`,
        `toolu_concurrent_2_${Date.now()}`,
        `toolu_concurrent_3_${Date.now()}`
      ];

      const createPromises = toolUseIds.map((toolUseId) =>
        fetch(`http://127.0.0.1:${WORKER_PORT}/api/sessions/observations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            claudeSessionId: TEST_SESSION_ID,
            tool_name: 'Read',
            tool_input: { file_path: '/test/file.ts' },
            tool_response: { content: 'export const test = 1;' },
            cwd: '/project',
            toolUseId
          })
        })
      );

      const createResponses = await Promise.all(createPromises);
      createResponses.forEach((response) => expect(response.ok).toBe(true));

      // Create 3 SSE connections simultaneously
      const ssePromises = toolUseIds.map(
        () =>
          new Promise<boolean>((resolve, reject) => {
            const timeout = setTimeout(() => {
              eventSource.close();
              reject(new Error('SSE timeout'));
            }, 30000);

            const eventSource = new EventSource(`http://127.0.0.1:${WORKER_PORT}/stream`);

            eventSource.addEventListener('processing_status', (event) => {
              try {
                const data = JSON.parse(event.data);
                if (data.queueDepth === 0) {
                  clearTimeout(timeout);
                  eventSource.close();
                  resolve(true);
                }
              } catch (error) {
                // Ignore
              }
            });

            eventSource.onerror = () => {
              clearTimeout(timeout);
              eventSource.close();
              reject(new Error('SSE error'));
            };
          })
      );

      // All 3 connections should complete
      const results = await Promise.all(ssePromises);
      results.forEach((result) => expect(result).toBe(true));
    }, 35000);

    it('should broadcast processing status updates during queue processing', async () => {
      // Create observation and track all SSE events
      const toolUseId = `toolu_broadcast_${Date.now()}`;

      await fetch(`http://127.0.0.1:${WORKER_PORT}/api/sessions/observations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          claudeSessionId: TEST_SESSION_ID,
          tool_name: 'Edit',
          tool_input: {
            file_path: '/test/file.ts',
            old_string: 'const PORT = 3000;',
            new_string: 'const PORT = 8080;'
          },
          tool_response: { success: true },
          cwd: '/project',
          toolUseId
        })
      });

      // Collect all processing_status events
      const events: any[] = [];

      const completed = await new Promise<boolean>((resolve, reject) => {
        const timeout = setTimeout(() => {
          eventSource.close();
          reject(new Error('SSE timeout'));
        }, 30000);

        const eventSource = new EventSource(`http://127.0.0.1:${WORKER_PORT}/stream`);

        eventSource.addEventListener('processing_status', (event) => {
          try {
            const data = JSON.parse(event.data);
            events.push(data);

            if (data.queueDepth === 0) {
              clearTimeout(timeout);
              eventSource.close();
              resolve(true);
            }
          } catch (error) {
            // Ignore
          }
        });

        eventSource.onerror = () => {
          clearTimeout(timeout);
          eventSource.close();
          reject(new Error('SSE error'));
        };
      });

      expect(completed).toBe(true);
      expect(events.length).toBeGreaterThan(0);

      // Last event should have queueDepth: 0
      const lastEvent = events[events.length - 1];
      expect(lastEvent.queueDepth).toBe(0);

      // All events should have required fields
      events.forEach((event) => {
        expect(event).toHaveProperty('queueDepth');
        expect(typeof event.queueDepth).toBe('number');
      });
    }, 35000);
  });

  describe('API Endpoints', () => {
    it('should fetch observations by tool_use_id', async () => {
      const toolUseId = `toolu_fetch_test_${Date.now()}`;

      // Create observation
      await fetch(`http://127.0.0.1:${WORKER_PORT}/api/sessions/observations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          claudeSessionId: TEST_SESSION_ID,
          tool_name: 'Grep',
          tool_input: { pattern: 'function.*main', path: '/project/src' },
          tool_response: { matches: ['src/index.ts:10:export function main() {'] },
          cwd: '/project',
          toolUseId
        })
      });

      // Wait for processing
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          eventSource.close();
          reject(new Error('SSE timeout'));
        }, 30000);

        const eventSource = new EventSource(`http://127.0.0.1:${WORKER_PORT}/stream`);

        eventSource.addEventListener('processing_status', (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.queueDepth === 0) {
              clearTimeout(timeout);
              eventSource.close();
              resolve();
            }
          } catch (error) {
            // Ignore
          }
        });

        eventSource.onerror = () => {
          clearTimeout(timeout);
          eventSource.close();
          reject(new Error('SSE error'));
        };
      });

      // Fetch observations
      const response = await fetch(
        `http://127.0.0.1:${WORKER_PORT}/api/sessions/observations-for-tool-use/${toolUseId}`
      );

      expect(response.ok).toBe(true);
      const result = await response.json();
      expect(result.observations).toBeDefined();
      expect(Array.isArray(result.observations)).toBe(true);
    }, 35000);

    it('should return empty array for non-existent tool_use_id', async () => {
      const response = await fetch(
        `http://127.0.0.1:${WORKER_PORT}/api/sessions/observations-for-tool-use/toolu_nonexistent`
      );

      expect(response.ok).toBe(true);
      const result = await response.json();
      expect(result.observations).toEqual([]);
    });
  });
});
