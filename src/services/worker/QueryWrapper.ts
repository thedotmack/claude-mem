/**
 * QueryWrapper - Child process target for SDK query lifecycle control
 *
 * This module runs as a child_process.fork() target to wrap Agent SDK's query()
 * in a controllable subprocess. This solves the zombie process accumulation bug
 * where SDK's internal Claude subprocesses don't terminate when queries hang.
 *
 * Architecture:
 * ┌─ Worker Service
 * │
 * └─ QueryWrapper (this process, forked with known PID)
 *    └─ Agent SDK query() (spawns internal subprocess)
 *
 * On timeout or abort: kill(wrapperPid, 'SIGTERM') → kills entire process tree
 *
 * @see https://github.com/thedotmack/claude-mem/issues/737
 */

// @ts-ignore - Agent SDK types may not be available
import { query } from '@anthropic-ai/claude-agent-sdk';

export interface WrapperMessage {
  type: 'start';
  options: {
    prompt: string;
    model: string;
    resume?: string;
    disallowedTools: string[];
    pathToClaudeCodeExecutable: string;
  };
  sessionDbId: number;
}

export interface WrapperResponse {
  type: 'message' | 'complete' | 'error' | 'ready';
  data?: any;
  error?: string;
  sessionDbId?: number;
}

// Only run wrapper logic when this file is the main module
if (typeof process !== 'undefined' && process.send) {
  // Signal ready to parent
  process.send({ type: 'ready' } as WrapperResponse);

  // Handle messages from parent
  process.on('message', async (msg: WrapperMessage) => {
    if (msg.type !== 'start') return;

    const { options, sessionDbId } = msg;
    const abortController = new AbortController();

    // Handle abort signal from parent (SIGTERM)
    process.on('SIGTERM', () => {
      abortController.abort();
    });

    try {
      // Create async generator from prompt string
      async function* createPromptGenerator(): AsyncIterableIterator<any> {
        yield {
          type: 'user',
          message: {
            role: 'user',
            content: options.prompt
          },
          session_id: undefined,
          parent_tool_use_id: null,
          isSynthetic: true
        };
      }

      // Run SDK query with our abort controller
      const queryResult = query({
        prompt: createPromptGenerator(),
        options: {
          model: options.model,
          ...(options.resume && { resume: options.resume }),
          disallowedTools: options.disallowedTools,
          abortController,
          pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable
        }
      });

      // Stream messages back to parent
      for await (const message of queryResult) {
        process.send!({
          type: 'message',
          data: message,
          sessionDbId
        } as WrapperResponse);
      }

      // Signal completion
      process.send!({ type: 'complete', sessionDbId } as WrapperResponse);
    } catch (error) {
      process.send!({
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
        sessionDbId
      } as WrapperResponse);
    }

    // Exit cleanly after query completes
    process.exit(0);
  });
}
