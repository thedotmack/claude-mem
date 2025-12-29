import type { SimpleQueue } from './SimpleQueue.js';
import type { QueueMessage } from './types.js';
import { logger } from '../../utils/logger.js';

/**
 * QueueProcessor - Simple polling-based queue consumer
 *
 * Polls the queue every 100ms, processes one message at a time.
 * On error, logs and deletes the message (no retries).
 */
export class QueueProcessor {
  private queue: SimpleQueue;
  private processMessage: (message: QueueMessage) => Promise<void>;
  private running: boolean = false;
  private pollIntervalMs: number;

  constructor(
    queue: SimpleQueue,
    processMessage: (message: QueueMessage) => Promise<void>,
    pollIntervalMs: number = 100
  ) {
    this.queue = queue;
    this.processMessage = processMessage;
    this.pollIntervalMs = pollIntervalMs;
  }

  /**
   * Start the processor loop
   */
  start(): void {
    if (this.running) {
      logger.warn('QueueProcessor', 'Already running');
      return;
    }

    this.running = true;
    logger.info('QueueProcessor', 'Starting queue processor');
    this.loop();
  }

  /**
   * Stop the processor loop
   */
  stop(): void {
    if (!this.running) {
      return;
    }

    this.running = false;
    logger.info('QueueProcessor', 'Stopping queue processor');
  }

  /**
   * Check if processor is running
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Main processing loop
   */
  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const message = this.queue.peek();

        if (message) {
          logger.debug('QueueProcessor', `Processing message ${message.id}`);

          try {
            await this.processMessage(message);
            logger.debug('QueueProcessor', `Message ${message.id} processed successfully`);
          } catch (error) {
            logger.error('QueueProcessor', `Message ${message.id} failed`, undefined, error);
          }

          // Always remove the message (no retries)
          this.queue.remove(message.id);
        }
      } catch (error) {
        logger.error('QueueProcessor', 'Error in processing loop', undefined, error);
      }

      // Wait before next poll
      await this.sleep(this.pollIntervalMs);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
