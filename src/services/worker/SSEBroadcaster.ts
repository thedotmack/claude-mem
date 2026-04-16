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
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Periodic heartbeat to detect and prune stale SSE connections.
    // This catches connections that died without firing 'close' (e.g., after /reload-plugins).
    this.heartbeatInterval = setInterval(() => {
      this.pruneDeadClients();
    }, 30_000); // Every 30 seconds
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

    // Also listen for error events to catch broken pipes
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

    // Single-pass write with dead client detection.
    // After /reload-plugins, some SSE clients may be stale (connection dropped
    // without firing 'close' event). Detect and remove them on write failure.
    const deadClients: SSEClient[] = [];
    for (const client of this.sseClients) {
      try {
        // Check if the underlying socket is still writable
        const res = client as any;
        if (res.writableEnded || res.destroyed || (res.socket && res.socket.destroyed)) {
          deadClients.push(client);
          continue;
        }
        client.write(data);
      } catch {
        deadClients.push(client);
      }
    }

    // Clean up dead clients detected during broadcast
    if (deadClients.length > 0) {
      for (const dead of deadClients) {
        this.sseClients.delete(dead);
      }
      logger.debug('WORKER', 'SSE dead clients cleaned up during broadcast', {
        removed: deadClients.length,
        remaining: this.sseClients.size
      });
    }
  }

  /**
   * Get number of connected clients
   */
  getClientCount(): number {
    return this.sseClients.size;
  }

  /**
   * Prune stale SSE connections that are no longer writable.
   * Called periodically by the heartbeat and during broadcast.
   */
  private pruneDeadClients(): void {
    if (this.sseClients.size === 0) return;

    const deadClients: SSEClient[] = [];
    for (const client of this.sseClients) {
      const res = client as any;
      if (res.writableEnded || res.destroyed || (res.socket && res.socket.destroyed)) {
        deadClients.push(client);
      }
    }

    if (deadClients.length > 0) {
      for (const dead of deadClients) {
        this.sseClients.delete(dead);
      }
      logger.debug('WORKER', 'SSE heartbeat pruned dead clients', {
        removed: deadClients.length,
        remaining: this.sseClients.size
      });
    }
  }

  /**
   * Stop the heartbeat and clean up all clients
   */
  destroy(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
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
