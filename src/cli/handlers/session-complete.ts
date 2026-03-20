/**
 * Session Complete Handler - Stop (Phase 2)
 *
 * Completes the session after summarize has been queued.
 * This removes the session from the active sessions map, allowing
 * the orphan reaper to clean up any remaining subprocess.
 *
 * Fixes Issue #842: Orphan reaper starts but never reaps because
 * sessions stay in the active sessions map forever.
 *
 * Two-path design (process-lifecycle-fix Phase 2):
 * - Path A (worker healthy): POST /api/sessions/complete via HTTP API.
 * - Path B (worker unreachable): kill all registered processes directly by PID
 *   using supervisor.json, with no HTTP dependency.
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { checkWorkerHealth, workerHttpRequest } from '../../shared/worker-utils.js';
import { killRegisteredProcesses } from '../../supervisor/registry-reader.js';
import { logger } from '../../utils/logger.js';

/** Health check timeout: 3s leaves ample room within the 30s hook budget. */
const HEALTH_CHECK_TIMEOUT_MS = 3000;

export const sessionCompleteHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const workerHealthy = await checkWorkerHealth(HEALTH_CHECK_TIMEOUT_MS);

    if (!workerHealthy) {
      return runFallbackPath();
    }

    return runApiPath(input.sessionId);
  }
};

/**
 * Path A — worker HTTP API is reachable.
 * Sends the session-complete signal. The worker stays persistent between sessions
 * (Solution B), so we do NOT call POST /api/shutdown here.
 */
async function runApiPath(sessionId: string | undefined): Promise<HookResult> {
  if (!sessionId) {
    logger.warn('HOOK', 'session-complete: Missing sessionId, skipping');
    return { continue: true, suppressOutput: true };
  }

  logger.info('HOOK', '→ session-complete (Path A): Removing session from active map', {
    contentSessionId: sessionId
  });

  try {
    const response = await workerHttpRequest('/api/sessions/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contentSessionId: sessionId })
    });

    if (!response.ok) {
      const text = await response.text();
      logger.warn('HOOK', 'session-complete: Failed to complete session', {
        status: response.status,
        body: text
      });
    } else {
      logger.info('HOOK', 'Session completed successfully', { contentSessionId: sessionId });
    }
  } catch (error) {
    // Log but don't fail — session may already be gone
    logger.warn('HOOK', 'session-complete: Error completing session', {
      error: (error as Error).message
    });
  }

  return { continue: true, suppressOutput: true };
}

/**
 * Path B — worker HTTP API is unreachable.
 * Reads supervisor.json and kills all registered subsystems (worker, mcp-server, chroma-mcp)
 * using OS-level signals (taskkill on Windows, SIGKILL on Unix).
 * Safe to run within the 30s hook budget: each taskkill completes in <1s.
 */
function runFallbackPath(): HookResult {
  process.stderr.write('[claude-mem] session-complete: worker unreachable, running PID-kill fallback\n');

  try {
    const { killed, failed } = killRegisteredProcesses();

    if (killed.length > 0) {
      process.stderr.write(`[claude-mem] session-complete: killed PIDs ${killed.join(', ')}\n`);
    }
    if (failed.length > 0) {
      process.stderr.write(`[claude-mem] session-complete: failed to kill PIDs ${failed.join(', ')}\n`);
    }
    if (killed.length === 0 && failed.length === 0) {
      process.stderr.write('[claude-mem] session-complete: no registered processes found to kill\n');
    }
  } catch (error) {
    // Never block the hook — fallback errors are diagnostic only
    process.stderr.write(`[claude-mem] session-complete: fallback error: ${(error as Error).message}\n`);
  }

  return { continue: true, suppressOutput: true };
}
