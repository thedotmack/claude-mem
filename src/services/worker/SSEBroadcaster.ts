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
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Periodic cleanup of dead/disconnected SSE clients every 30 seconds
    this.cleanupInterval = setInterval(() => {
      this.cleanupDeadClients();
    }, 30_000);
  }

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

    // Also handle error events (e.g., broken pipe)
    res.on('error', () => {
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
   * Remove all dead/disconnected clients from the active set.
   * Checks each client's underlying socket for writability.
   */
  private cleanupDeadClients(): void {
    const initialSize = this.sseClients.size;
    if (initialSize === 0) return;

    const deadClients: SSEClient[] = [];
    for (const client of this.sseClients) {
      // Check if the underlying socket is destroyed or not writable
      if (client.writableEnded || client.writableFinished || client.destroyed) {
        deadClients.push(client);
      }
    }

    for (const dead of deadClients) {
      this.sseClients.delete(dead);
    }

    if (deadClients.length > 0) {
      logger.debug('WORKER', 'Cleaned up dead SSE clients', {
        removed: deadClients.length,
        remaining: this.sseClients.size
      });
    }
  }

  /**
   * Broadcast an event to all connected clients (single-pass with dead client cleanup)
   */
  broadcast(event: SSEEvent): void {
    if (this.sseClients.size === 0) {
      logger.debug('WORKER', 'SSE broadcast skipped (no clients)', { eventType: event.type });
      return; // Short-circuit if no clients
    }

    const eventWithTimestamp = { ...event, timestamp: Date.now() };
    const data = `data: ${JSON.stringify(eventWithTimestamp)}\n\n`;

    logger.debug('WORKER', 'SSE broadcast sent', { eventType: event.type, clients: this.sseClients.size });

    // Single-pass write with inline dead client cleanup
    const deadClients: SSEClient[] = [];
    for (const client of this.sseClients) {
      try {
        if (client.writableEnded || client.destroyed) {
          deadClients.push(client);
        } else {
          client.write(data);
        }
      } catch {
        deadClients.push(client);
      }
    }

    // Remove any dead clients discovered during broadcast
    for (const dead of deadClients) {
      this.sseClients.delete(dead);
    }
  }

  /**
   * Get number of connected clients
   */
  getClientCount(): number {
    return this.sseClients.size;
  }

  /**
   * Stop the periodic cleanup interval.
   * Call this during graceful shutdown.
   */
  dispose(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.sseClients.clear();
  }

  /**
   * Send event to a specific client
   */
  private sendToClient(res: Response, event: SSEEvent): void {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    res.write(data);
  }
}
