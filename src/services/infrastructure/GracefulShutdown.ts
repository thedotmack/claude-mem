/**
 * GracefulShutdown - Cleanup utilities for graceful exit
 *
 * Extracted from worker-service.ts to provide centralized shutdown coordination.
 * Handles:
 * - HTTP server closure (with Windows-specific delays)
 * - Session manager shutdown coordination
 * - Child process cleanup (Windows zombie port fix)
 */

import http from 'http';
import { logger } from '../../utils/logger.js';
import {
  getChildProcesses,
  forceKillProcess,
  waitForProcessesExit,
  removePidFile
} from './ProcessManager.js';

export interface ShutdownableService {
  shutdownAll(): Promise<void>;
}

export interface CloseableClient {
  close(): Promise<void>;
}

export interface CloseableDatabase {
  close(): Promise<void>;
}

/**
 * Configuration for graceful shutdown
 */
export interface GracefulShutdownConfig {
  server: http.Server | null;
  sessionManager: ShutdownableService;
  mcpClient?: CloseableClient;
  dbManager?: CloseableDatabase;
}

/**
 * Perform graceful shutdown of all services
 *
 * IMPORTANT: On Windows, we must kill all child processes before exiting
 * to prevent zombie ports. The socket handle can be inherited by children,
 * and if not properly closed, the port stays bound after process death.
 */
export async function performGracefulShutdown(config: GracefulShutdownConfig): Promise<void> {
  logger.info('SYSTEM', 'Shutdown initiated');

  // Clean up PID file on shutdown
  removePidFile();

  // STEP 1: Enumerate all child processes BEFORE we start closing things
  const childPids = await getChildProcesses(process.pid);
  logger.info('SYSTEM', 'Found child processes', { count: childPids.length, pids: childPids });

  // STEP 2: Close HTTP server first
  if (config.server) {
    await closeHttpServer(config.server);
    logger.info('SYSTEM', 'HTTP server closed');
  }

  // STEP 3: Shutdown active sessions
  await config.sessionManager.shutdownAll();

  // STEP 4: Close MCP client connection (signals child to exit gracefully)
  if (config.mcpClient) {
    await config.mcpClient.close();
    logger.info('SYSTEM', 'MCP client closed');
  }

  // STEP 5: Close database connection (includes ChromaSync cleanup)
  if (config.dbManager) {
    await config.dbManager.close();
  }

  // STEP 6: Force kill any remaining child processes (Windows zombie port fix)
  if (childPids.length > 0) {
    logger.info('SYSTEM', 'Force killing remaining children');
    for (const pid of childPids) {
      await forceKillProcess(pid);
    }
    // Wait for children to fully exit
    await waitForProcessesExit(childPids, 5000);
  }

  logger.info('SYSTEM', 'Worker shutdown complete');
}

/**
 * Close HTTP server with Windows-specific delays
 * Windows needs extra time to release sockets properly
 */
async function closeHttpServer(server: http.Server): Promise<void> {
  // Close all active connections
  server.closeAllConnections();

  // Give Windows time to close connections before closing server (prevents zombie ports)
  if (process.platform === 'win32') {
    await new Promise(r => setTimeout(r, 500));
  }

  // Close the server
  await new Promise<void>((resolve, reject) => {
    server.close(err => err ? reject(err) : resolve());
  });

  // Extra delay on Windows to ensure port is fully released
  if (process.platform === 'win32') {
    await new Promise(r => setTimeout(r, 500));
    logger.info('SYSTEM', 'Waited for Windows port cleanup');
  }
}
