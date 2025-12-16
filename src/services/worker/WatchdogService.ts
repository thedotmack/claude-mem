/**
 * WatchdogService: Detect stuck sessions and trigger recovery
 *
 * Responsibilities:
 * - Periodically check for stuck messages (processing > threshold)
 * - Reset stuck messages back to pending for retry
 * - Restart SDK agents for sessions with pending work but no active generator
 * - Cleanup old processed messages (retention policy)
 */

import { PendingMessageStore } from '../sqlite/PendingMessageStore.js';
import { SessionManager } from './SessionManager.js';
import { SDKAgent } from './SDKAgent.js';
import { logger } from '../../utils/logger.js';
import type { ActiveSession } from '../worker-types.js';

export interface WatchdogConfig {
  checkIntervalMs: number;      // How often to check (default: 30000 = 30s)
  stuckThresholdMs: number;     // When to consider a message stuck (default: 150000 = 2.5min)
  maxRetries: number;           // Max retry attempts before permanent failure (default: 3)
  retentionMs: number;          // How long to keep processed messages (default: 24 hours)
}

const DEFAULT_CONFIG: WatchdogConfig = {
  checkIntervalMs: 30000,       // 30 seconds
  stuckThresholdMs: 150000,     // 2.5 minutes
  maxRetries: 3,
  retentionMs: 24 * 60 * 60 * 1000  // 24 hours
};

export class WatchdogService {
  private timer: NodeJS.Timeout | null = null;
  private config: WatchdogConfig;
  private pendingMessageStore: PendingMessageStore;
  private sessionManager: SessionManager;
  private sdkAgent: SDKAgent;
  private workerRef: any;  // Reference to WorkerService for spinner updates

  constructor(
    pendingMessageStore: PendingMessageStore,
    sessionManager: SessionManager,
    sdkAgent: SDKAgent,
    workerRef?: any,
    config?: Partial<WatchdogConfig>
  ) {
    this.pendingMessageStore = pendingMessageStore;
    this.sessionManager = sessionManager;
    this.sdkAgent = sdkAgent;
    this.workerRef = workerRef;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Start the watchdog timer
   */
  start(): void {
    if (this.timer) {
      return; // Already running
    }

    this.timer = setInterval(() => this.check(), this.config.checkIntervalMs);

    logger.info('WATCHDOG', 'Started', {
      checkInterval: `${this.config.checkIntervalMs / 1000}s`,
      stuckThreshold: `${this.config.stuckThresholdMs / 1000}s`,
      maxRetries: this.config.maxRetries
    });
  }

  /**
   * Stop the watchdog timer
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('WATCHDOG', 'Stopped');
    }
  }

  /**
   * Perform a watchdog check
   */
  private async check(): Promise<void> {
    try {
      // 1. Reset stuck messages (processing for too long)
      const resetCount = this.pendingMessageStore.resetStuckMessages(this.config.stuckThresholdMs);
      if (resetCount > 0) {
        logger.warn('WATCHDOG', 'Reset stuck messages', { count: resetCount });
      }

      // 2. Find sessions with pending messages but no active generator
      const sessionsWithPending = this.pendingMessageStore.getSessionsWithPendingMessages();

      for (const sessionDbId of sessionsWithPending) {
        const session = this.sessionManager.getSession(sessionDbId);

        if (session) {
          // Session exists in memory
          if (!session.generatorPromise) {
            // No active generator, restart it
            logger.warn('WATCHDOG', 'Restarting generator for session with pending messages', {
              sessionDbId,
              pendingCount: this.pendingMessageStore.getPendingCount(sessionDbId)
            });

            this.startGeneratorForSession(session);
          }
        } else {
          // Session not in memory but has pending messages - recover it
          logger.warn('WATCHDOG', 'Recovering orphaned session', { sessionDbId });

          const recoveredSession = this.sessionManager.initializeSession(sessionDbId);
          this.startGeneratorForSession(recoveredSession);
        }
      }

      // 3. Cleanup old processed messages (retention policy)
      const cleanedCount = this.pendingMessageStore.cleanupProcessed(this.config.retentionMs);
      if (cleanedCount > 0) {
        logger.debug('WATCHDOG', 'Cleaned up old processed messages', { count: cleanedCount });
      }

    } catch (error: any) {
      logger.error('WATCHDOG', 'Check failed', {}, error);
    }
  }

  /**
   * Start SDK agent generator for a session
   */
  private startGeneratorForSession(session: ActiveSession): void {
    session.generatorPromise = this.sdkAgent.startSession(session, this.workerRef)
      .catch(err => {
        logger.failure('SDK', 'Watchdog-initiated agent error', { sessionDbId: session.sessionDbId }, err);
      })
      .finally(() => {
        session.generatorPromise = null;
        // Broadcast status update
        if (this.workerRef && typeof this.workerRef.broadcastProcessingStatus === 'function') {
          this.workerRef.broadcastProcessingStatus();
        }
      });

    // Broadcast immediately so UI knows agent is now active
    if (this.workerRef && typeof this.workerRef.broadcastProcessingStatus === 'function') {
      this.workerRef.broadcastProcessingStatus();
    }
  }

  /**
   * Recover pending messages on startup (crash recovery)
   * Called once during worker initialization
   */
  async recoverPendingMessages(): Promise<void> {
    // Reset any messages stuck in 'processing' state (crash recovery)
    const resetCount = this.pendingMessageStore.resetStuckMessages(0);
    if (resetCount > 0) {
      logger.warn('RECOVERY', 'Reset messages stuck in processing state', { count: resetCount });
    }

    // Find all sessions with pending messages
    const sessionsWithPending = this.pendingMessageStore.getSessionsWithPendingMessages();

    for (const sessionDbId of sessionsWithPending) {
      const pendingCount = this.pendingMessageStore.getPendingCount(sessionDbId);
      logger.info('RECOVERY', 'Recovering session with pending messages', {
        sessionDbId,
        pendingCount
      });

      // Initialize session from database
      const session = this.sessionManager.initializeSession(sessionDbId);

      // Start SDK agent to process pending queue
      this.startGeneratorForSession(session);
    }

    if (sessionsWithPending.length > 0) {
      logger.success('RECOVERY', 'Recovered sessions', { count: sessionsWithPending.length });
    }
  }
}
