import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { TranscriptEventProcessor } from '../../src/services/transcripts/processor.js';
import { SAMPLE_CONFIG } from '../../src/services/transcripts/config.js';
import type { WatchTarget, TranscriptSchema } from '../../src/services/transcripts/types.js';

/**
 * Tests for Codex Transcript Ingestion
 *
 * These tests verify that Codex CLI transcript events are correctly processed
 * and transformed into claude-mem observations through the TranscriptEventProcessor.
 *
 * Uses spyOn to verify handler calls, parameters, and behavior.
 */

describe('Codex Transcript Ingestion', () => {
  let processor: TranscriptEventProcessor;
  let codexSchema: TranscriptSchema;
  let codexWatch: WatchTarget;

  // Spies for handlers
  let sessionInitSpy: ReturnType<typeof spyOn>;
  let observationSpy: ReturnType<typeof spyOn>;
  let fileEditSpy: ReturnType<typeof spyOn>;
  let sessionCompleteSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    // Create new processor instance for each test
    processor = new TranscriptEventProcessor();
    codexSchema = SAMPLE_CONFIG.schemas!.codex;
    codexWatch = SAMPLE_CONFIG.watches[0];

    // Import handlers dynamically to spy on them
    const sessionInitModule = await import('../../src/cli/handlers/session-init.js');
    const observationModule = await import('../../src/cli/handlers/observation.js');
    const fileEditModule = await import('../../src/cli/handlers/file-edit.js');
    const sessionCompleteModule = await import('../../src/cli/handlers/session-complete.js');

    // Clear any existing spies and create new ones
    if (sessionInitSpy) sessionInitSpy.mockRestore();
    if (observationSpy) observationSpy.mockRestore();
    if (fileEditSpy) fileEditSpy.mockRestore();
    if (sessionCompleteSpy) sessionCompleteSpy.mockRestore();

    // Spy on handler execute methods
    sessionInitSpy = spyOn(sessionInitModule.sessionInitHandler, 'execute').mockResolvedValue(undefined);
    observationSpy = spyOn(observationModule.observationHandler, 'execute').mockResolvedValue(undefined);
    fileEditSpy = spyOn(fileEditModule.fileEditHandler, 'execute').mockResolvedValue(undefined);
    sessionCompleteSpy = spyOn(sessionCompleteModule.sessionCompleteHandler, 'execute').mockResolvedValue(undefined);
  });

  afterEach(() => {
    // Spies are automatically restored by Bun
  });

  describe('user-message event', () => {
    it('should trigger sessionInitHandler.execute', async () => {
      const sessionMetaEvent = {
        type: 'session_meta',
        payload: {
          id: 'test-session-123',
          cwd: '/home/user/project'
        },
        timestamp: '2026-03-11T21:00:00Z'
      };

      const userMessageEvent = {
        type: 'event',
        payload: {
          type: 'user_message',
          message: 'Fix the bug in auth.ts'
        },
        timestamp: '2026-03-11T21:02:00Z'
      };

      await processor.processEntry(sessionMetaEvent, codexWatch, codexSchema, 'test-session-123');
      await processor.processEntry(userMessageEvent, codexWatch, codexSchema, 'test-session-123');

      expect(sessionInitSpy).toHaveBeenCalledTimes(1);
      expect(sessionInitSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'test-session-123',
          prompt: 'Fix the bug in auth.ts'
        })
      );
    });
  });

  describe('tool-use and tool-result events', () => {
    it('should trigger observationHandler.execute for function_call', async () => {
      const sessionMetaEvent = {
        type: 'session_meta',
        payload: {
          id: 'test-session-456',
          cwd: '/home/user/project'
        },
        timestamp: '2026-03-11T21:00:00Z'
      };

      const toolUseEvent = {
        type: 'event',
        payload: {
          type: 'function_call',
          call_id: 'call_abc123',
          name: 'read_file',
          arguments: { path: '/home/user/project/auth.ts' }
        },
        timestamp: '2026-03-11T21:04:00Z'
      };

      const toolResultEvent = {
        type: 'event',
        payload: {
          type: 'function_call_output',
          call_id: 'call_abc123',
          output: 'export function validateToken(token: string) { ... }'
        },
        timestamp: '2026-03-11T21:05:00Z'
      };

      await processor.processEntry(sessionMetaEvent, codexWatch, codexSchema, 'test-session-456');
      await processor.processEntry(toolUseEvent, codexWatch, codexSchema, 'test-session-456');
      await processor.processEntry(toolResultEvent, codexWatch, codexSchema, 'test-session-456');

      expect(observationSpy).toHaveBeenCalledTimes(1);
      expect(observationSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'test-session-456',
          toolName: 'read_file'
        })
      );
    });

    it('should use web_search fallback for web_search_call', async () => {
      const sessionMetaEvent = {
        type: 'session_meta',
        payload: {
          id: 'test-session-789',
          cwd: '/home/user/project'
        },
        timestamp: '2026-03-11T21:00:00Z'
      };

      const webSearchEvent = {
        type: 'event',
        payload: {
          type: 'web_search_call',
          call_id: 'call_web123',
          action: { query: 'JWT token validation best practices' }
        },
        timestamp: '2026-03-11T21:06:00Z'
      };

      const webSearchResultEvent = {
        type: 'event',
        payload: {
          type: 'function_call_output',
          call_id: 'call_web123',
          output: 'Search results...'
        },
        timestamp: '2026-03-11T21:07:00Z'
      };

      await processor.processEntry(sessionMetaEvent, codexWatch, codexSchema, 'test-session-789');
      await processor.processEntry(webSearchEvent, codexWatch, codexSchema, 'test-session-789');
      await processor.processEntry(webSearchResultEvent, codexWatch, codexSchema, 'test-session-789');

      expect(observationSpy).toHaveBeenCalledTimes(1);
      expect(observationSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'test-session-789',
          toolName: 'web_search'
        })
      );
    });
  });

  describe('session-end events', () => {
    it('should trigger sessionCompleteHandler.execute for turn_aborted', async () => {
      const sessionMetaEvent = {
        type: 'session_meta',
        payload: {
          id: 'test-session-abort',
          cwd: '/home/user/project'
        },
        timestamp: '2026-03-11T21:00:00Z'
      };

      const sessionEndEvent = {
        type: 'event',
        payload: {
          type: 'turn_aborted'
        },
        timestamp: '2026-03-11T21:09:00Z'
      };

      await processor.processEntry(sessionMetaEvent, codexWatch, codexSchema, 'test-session-abort');
      await processor.processEntry(sessionEndEvent, codexWatch, codexSchema, 'test-session-abort');

      expect(sessionCompleteSpy).toHaveBeenCalledTimes(1);
      expect(sessionCompleteSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'test-session-abort',
          platform: 'transcript'
        })
      );
    });

    it('should trigger sessionCompleteHandler.execute for task_complete', async () => {
      const sessionMetaEvent = {
        type: 'session_meta',
        payload: {
          id: 'test-session-complete',
          cwd: '/home/user/project'
        },
        timestamp: '2026-03-11T21:00:00Z'
      };

      const sessionEndEvent = {
        type: 'event',
        payload: {
          type: 'task_complete'
        },
        timestamp: '2026-03-11T21:10:00Z'
      };

      await processor.processEntry(sessionMetaEvent, codexWatch, codexSchema, 'test-session-complete');
      await processor.processEntry(sessionEndEvent, codexWatch, codexSchema, 'test-session-complete');

      expect(sessionCompleteSpy).toHaveBeenCalledTimes(1);
      expect(sessionCompleteSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'test-session-complete',
          platform: 'transcript'
        })
      );
    });
  });

  describe('complete session flow', () => {
    it('should process full session with all handler calls', async () => {
      const events = [
        // Session metadata
        {
          type: 'session_meta',
          payload: {
            id: 'session-flow-test',
            cwd: '/home/user/project'
          },
          timestamp: '2026-03-11T21:00:00Z'
        },
        // User message
        {
          type: 'event',
          payload: {
            type: 'user_message',
            message: 'Add error handling to the API'
          },
          timestamp: '2026-03-11T21:00:01Z'
        },
        // Tool use
        {
          type: 'event',
          payload: {
            type: 'function_call',
            call_id: 'call_001',
            name: 'read_file',
            arguments: { path: 'api/routes.ts' }
          },
          timestamp: '2026-03-11T21:00:03Z'
        },
        // Tool result
        {
          type: 'event',
          payload: {
            type: 'function_call_output',
            call_id: 'call_001',
            output: 'export function handleRequest() { ... }'
          },
          timestamp: '2026-03-11T21:00:04Z'
        },
        // Session end
        {
          type: 'event',
          payload: {
            type: 'task_complete'
          },
          timestamp: '2026-03-11T21:00:05Z'
        }
      ];

      for (const event of events) {
        await processor.processEntry(event, codexWatch, codexSchema, 'session-flow-test');
      }

      // Verify all handlers were called
      expect(sessionInitSpy).toHaveBeenCalledTimes(1);
      expect(observationSpy).toHaveBeenCalledTimes(1);
      expect(sessionCompleteSpy).toHaveBeenCalledTimes(1);

      // Verify session init was called with correct prompt
      expect(sessionInitSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'session-flow-test',
          prompt: 'Add error handling to the API'
        })
      );

      // Verify observation was called with correct tool
      expect(observationSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'session-flow-test',
          toolName: 'read_file'
        })
      );

      // Verify session complete was called
      expect(sessionCompleteSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'session-flow-test',
          platform: 'transcript'
        })
      );
    });
  });

  describe('field extraction with coalesce', () => {
    it('should extract toolInput from arguments field', async () => {
      const sessionMetaEvent = {
        type: 'session_meta',
        payload: {
          id: 'test-coalesce-1',
          cwd: '/home/user/project'
        },
        timestamp: '2026-03-11T21:00:00Z'
      };

      const toolUseEvent = {
        type: 'event',
        payload: {
          type: 'function_call',
          call_id: 'call_coalesce_1',
          name: 'test_tool',
          arguments: { key: 'value' }
        },
        timestamp: '2026-03-11T21:00:01Z'
      };

      const toolResultEvent = {
        type: 'event',
        payload: {
          type: 'function_call_output',
          call_id: 'call_coalesce_1',
          output: 'result'
        },
        timestamp: '2026-03-11T21:00:02Z'
      };

      await processor.processEntry(sessionMetaEvent, codexWatch, codexSchema, 'test-coalesce-1');
      await processor.processEntry(toolUseEvent, codexWatch, codexSchema, 'test-coalesce-1');
      await processor.processEntry(toolResultEvent, codexWatch, codexSchema, 'test-coalesce-1');

      expect(observationSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          toolInput: { key: 'value' }
        })
      );
    });

    it('should extract toolInput from input field when arguments missing', async () => {
      const sessionMetaEvent = {
        type: 'session_meta',
        payload: {
          id: 'test-coalesce-2',
          cwd: '/home/user/project'
        },
        timestamp: '2026-03-11T21:00:00Z'
      };

      const toolUseEvent = {
        type: 'event',
        payload: {
          type: 'custom_tool_call',
          call_id: 'call_coalesce_2',
          name: 'custom_tool',
          input: { data: 'test' }
        },
        timestamp: '2026-03-11T21:00:01Z'
      };

      const toolResultEvent = {
        type: 'event',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'call_coalesce_2',
          output: 'result'
        },
        timestamp: '2026-03-11T21:00:02Z'
      };

      await processor.processEntry(sessionMetaEvent, codexWatch, codexSchema, 'test-coalesce-2');
      await processor.processEntry(toolUseEvent, codexWatch, codexSchema, 'test-coalesce-2');
      await processor.processEntry(toolResultEvent, codexWatch, codexSchema, 'test-coalesce-2');

      expect(observationSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          toolInput: { data: 'test' }
        })
      );
    });
  });
});
