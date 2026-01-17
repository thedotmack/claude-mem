/**
 * QueryWrapperManager - Manages forked query wrapper processes
 *
 * Tracks all active query wrapper processes and provides:
 * - PID-based lifecycle control (timeout kills, shutdown cleanup)
 * - Event-driven message streaming from wrappers
 * - Automatic cleanup on completion/error/timeout
 *
 * This is the core fix for the zombie subprocess accumulation bug.
 * @see https://github.com/thedotmack/claude-mem/issues/737
 */

import { fork, ChildProcess } from 'child_process';
import path from 'path';
import { logger } from '../../utils/logger.js';
import type { WrapperMessage, WrapperResponse } from './QueryWrapper.js';

export interface TrackedQuery {
  child: ChildProcess;
  timeoutId: NodeJS.Timeout | null;
  sessionDbId: number;
  startTime: number;
}

// Global registry of active query wrappers
const activeQueries = new Map<number, TrackedQuery>();

// Default timeout: 5 minutes
const DEFAULT_QUERY_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Get the path to the compiled QueryWrapper module
 * In production, this will be in the same directory as the worker service
 */
function getWrapperPath(): string {
  // __dirname in ESM context via import.meta.url
  const currentDir = path.dirname(new URL(import.meta.url).pathname);
  // Try .js first (ESM output), then .cjs (CommonJS output)
  return path.join(currentDir, 'QueryWrapper.js');
}

/**
 * Helper to convert child process messages to async iterator
 */
async function* childMessages(
  child: ChildProcess,
  sessionDbId: number
): AsyncGenerator<WrapperResponse> {
  const messageQueue: WrapperResponse[] = [];
  let resolveNext: ((value: IteratorResult<WrapperResponse>) => void) | null = null;
  let done = false;

  const onMessage = (msg: WrapperResponse) => {
    if (msg.type === 'complete' || msg.type === 'error') {
      done = true;
    }
    if (resolveNext) {
      resolveNext({ value: msg, done: false });
      resolveNext = null;
    } else {
      messageQueue.push(msg);
    }
  };

  const onClose = () => {
    done = true;
    if (resolveNext) {
      resolveNext({ value: undefined as any, done: true });
      resolveNext = null;
    }
  };

  const onError = (error: Error) => {
    logger.error('WRAPPER', 'Child process error', { sessionDbId }, error);
    done = true;
    messageQueue.push({
      type: 'error',
      error: error.message,
      sessionDbId
    });
    if (resolveNext) {
      resolveNext({ value: messageQueue.shift()!, done: false });
      resolveNext = null;
    }
  };

  child.on('message', onMessage);
  child.on('close', onClose);
  child.on('error', onError);

  try {
    while (!done || messageQueue.length > 0) {
      if (messageQueue.length > 0) {
        const msg = messageQueue.shift()!;
        if (msg.type === 'complete' || msg.type === 'error') {
          yield msg;
          return;
        }
        yield msg;
      } else if (!done) {
        yield await new Promise<WrapperResponse>((resolve) => {
          resolveNext = (result) => resolve(result.value);
        });
      }
    }
  } finally {
    child.off('message', onMessage);
    child.off('close', onClose);
    child.off('error', onError);
  }
}

/**
 * Execute a query via forked wrapper process with timeout control
 *
 * @param options Query options to pass to SDK
 * @param sessionDbId Session ID for tracking and logging
 * @param timeoutMs Timeout in milliseconds (default: 5 minutes)
 * @yields SDK messages from the wrapper process
 */
export async function* queryWithWrapper(
  options: {
    prompt: string;
    model: string;
    resume?: string;
    disallowedTools: string[];
    pathToClaudeCodeExecutable: string;
  },
  sessionDbId: number,
  timeoutMs: number = DEFAULT_QUERY_TIMEOUT_MS
): AsyncGenerator<any> {
  const wrapperPath = getWrapperPath();

  logger.info('WRAPPER', 'Forking query wrapper', {
    sessionDbId,
    timeoutMs,
    wrapperPath
  });

  // Fork with detached: false so kill propagates to children
  const child = fork(wrapperPath, [], {
    detached: false,
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    env: {
      ...process.env,
      // Ensure the wrapper can find its dependencies
      NODE_OPTIONS: ''
    }
  });

  if (!child.pid) {
    throw new Error('Failed to fork query wrapper process');
  }

  logger.info('WRAPPER', 'Query wrapper forked', {
    sessionDbId,
    pid: child.pid
  });

  // Cleanup function
  const cleanup = (reason: string) => {
    const tracked = activeQueries.get(sessionDbId);
    if (!tracked) return;

    if (tracked.timeoutId) {
      clearTimeout(tracked.timeoutId);
    }
    activeQueries.delete(sessionDbId);

    if (!child.killed) {
      logger.info('WRAPPER', `Killing wrapper (${reason})`, {
        sessionDbId,
        pid: child.pid,
        runTime: Date.now() - tracked.startTime
      });

      // Graceful first
      child.kill('SIGTERM');

      // Force kill after 5 seconds if still alive
      setTimeout(() => {
        if (!child.killed) {
          logger.warn('WRAPPER', 'Force killing wrapper after SIGTERM timeout', {
            sessionDbId,
            pid: child.pid
          });
          child.kill('SIGKILL');
        }
      }, 5000);
    }
  };

  // Set up timeout
  const timeoutId = setTimeout(() => {
    logger.warn('WRAPPER', `Query timeout after ${timeoutMs}ms`, {
      sessionDbId,
      pid: child.pid
    });
    cleanup('timeout');
  }, timeoutMs);

  // Track the query
  const tracked: TrackedQuery = {
    child,
    timeoutId,
    sessionDbId,
    startTime: Date.now()
  };
  activeQueries.set(sessionDbId, tracked);

  try {
    // Wait for wrapper to signal ready
    const readyPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Wrapper ready timeout'));
      }, 10000);

      const onMessage = (msg: WrapperResponse) => {
        if (msg.type === 'ready') {
          clearTimeout(timeout);
          child.off('message', onMessage);
          resolve();
        }
      };
      child.on('message', onMessage);
    });

    await readyPromise;

    // Send start message with query options
    const startMessage: WrapperMessage = {
      type: 'start',
      options,
      sessionDbId
    };
    child.send(startMessage);

    // Stream messages from wrapper
    for await (const msg of childMessages(child, sessionDbId)) {
      if (msg.type === 'message' && msg.data) {
        yield msg.data;
      } else if (msg.type === 'error') {
        throw new Error(msg.error || 'Unknown wrapper error');
      } else if (msg.type === 'complete') {
        break;
      }
    }
  } finally {
    cleanup('complete');
  }
}

/**
 * Get the number of active query wrappers
 */
export function getActiveQueryCount(): number {
  return activeQueries.size;
}

/**
 * Get details of all active query wrappers (for debugging)
 */
export function getActiveQueryDetails(): Array<{
  sessionDbId: number;
  pid: number | undefined;
  runTime: number;
}> {
  const now = Date.now();
  return Array.from(activeQueries.entries()).map(([sessionDbId, tracked]) => ({
    sessionDbId,
    pid: tracked.child.pid,
    runTime: now - tracked.startTime
  }));
}

/**
 * Kill all active query wrappers
 * Called during graceful shutdown to prevent zombie accumulation
 */
export function killAllActiveQueries(): void {
  const count = activeQueries.size;
  if (count === 0) {
    logger.debug('WRAPPER', 'No active query wrappers to kill');
    return;
  }

  logger.info('WRAPPER', 'Killing all active query wrappers', { count });

  for (const [sessionDbId, tracked] of activeQueries) {
    if (tracked.timeoutId) {
      clearTimeout(tracked.timeoutId);
    }

    if (!tracked.child.killed) {
      logger.info('WRAPPER', 'Killing query wrapper on shutdown', {
        sessionDbId,
        pid: tracked.child.pid,
        runTime: Date.now() - tracked.startTime
      });
      tracked.child.kill('SIGKILL');
    }
  }

  activeQueries.clear();
  logger.info('WRAPPER', 'All query wrappers killed', { count });
}
