/**
 * SSEBroadcaster: SSE client management
 *
 * Responsibility:
 * - Manage SSE client connections
 * - Broadcast events to all connected clients
 * - Handle disconnections gracefully
 * - Single-pass broadcast (no two-step cleanup)
 */

import type { Response } from 'express';
import { logger } from '../../utils/logger.js';
import type { SSEEvent, SSEClient } from '../worker-types.js';

export class SSEBroadcaster {
  private sseClients: Set<SSEClient> = new Set();

  /**
   * Add a new SSE client connection
   */
  addClient(res: Response): void {
    this.sseClients.add(res);
    logger.debug('WORKER', 'Client connected', { total: this.sseClients.size });

    // Setup cleanup on disconnect
    res.on('close', () => {
      this.removeClient(res);
    });

    // Send initial event
    this.sendToClient(res, { type: 'connected', timestamp: Date.now() });
  }

  /**
   * Remove a client connection
   */
  removeClient(res: Response): void {
    this.sseClients.delete(res);
    logger.debug('WORKER', 'Client disconnected', { total: this.sseClients.size });
  }

  /**
   * Broadcast an event to all connected clients (single-pass)
   */
  broadcast(event: SSEEvent): void {
    if (this.sseClients.size === 0) {
      logger.debug('WORKER', 'SSE broadcast skipped (no clients)', { eventType: event.type });
      return; // Short-circuit if no clients
    }

    const eventWithTimestamp = { ...event, timestamp: Date.now() };
    const data = `data: ${JSON.stringify(eventWithTimestamp)}\n\n`;

    logger.debug('WORKER', 'SSE broadcast sent', { eventType: event.type, clients: this.sseClients.size });

    // Single-pass write
    for (const client of this.sseClients) {
      client.write(data);
    }
  }

  /**
   * Get number of connected clients
   */
  getClientCount(): number {
    return this.sseClients.size;
  }

  /**
   * Send event to a specific client
   */
  private sendToClient(res: Response, event: SSEEvent): void {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    res.write(data);
  }
}
