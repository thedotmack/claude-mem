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

const DEFAULT_HEARTBEAT_INTERVAL_MS = 25000;
const MIN_HEARTBEAT_INTERVAL_MS = 5000;

function resolveHeartbeatIntervalMs(raw: string | undefined): number {
  if (!raw || raw.trim() === '') return DEFAULT_HEARTBEAT_INTERVAL_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_HEARTBEAT_INTERVAL_MS;
  if (parsed <= 0) return 0; // Explicitly disable heartbeats
  return Math.max(parsed, MIN_HEARTBEAT_INTERVAL_MS);
}

export class SSEBroadcaster {
  private sseClients: Set<SSEClient> = new Set();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly heartbeatIntervalMs: number = resolveHeartbeatIntervalMs(process.env.CLAUDE_MEM_SSE_HEARTBEAT_MS)
  ) {}

  /**
   * Add a new SSE client connection
   */
  addClient(res: Response): void {
    this.sseClients.add(res);
    this.startHeartbeatIfNeeded();
    logger.debug('WORKER', 'Client connected', { total: this.sseClients.size });

    // Setup cleanup on disconnect
    const cleanup = () => {
      this.removeClient(res);
    };
    res.on('close', cleanup);
    res.on('end', cleanup);
    res.on('error', cleanup);

    // Send initial event
    this.sendToClient(res, { type: 'connected', timestamp: Date.now() });
  }

  /**
   * Remove a client connection
   */
  removeClient(res: Response): void {
    this.sseClients.delete(res);
    if (this.sseClients.size === 0) {
      this.stopHeartbeat();
    }
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

    const data = this.serializeEvent(event);

    logger.debug('WORKER', 'SSE broadcast sent', { eventType: event.type, clients: this.sseClients.size });

    // Single-pass write
    for (const client of this.sseClients) {
      this.writeToClient(client, data);
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
  sendToClient(res: SSEClient, event: SSEEvent): void {
    this.writeToClient(res, this.serializeEvent(event));
  }

  private serializeEvent(event: SSEEvent): string {
    const eventWithTimestamp = { ...event, timestamp: Date.now() };
    return `data: ${JSON.stringify(eventWithTimestamp)}\n\n`;
  }

  private writeToClient(client: SSEClient, payload: string): void {
    try {
      client.write(payload);
    } catch {
      this.removeClient(client);
    }
  }

  private startHeartbeatIfNeeded(): void {
    if (this.heartbeatIntervalMs <= 0) return;
    if (this.heartbeatTimer || this.sseClients.size === 0) return;

    this.heartbeatTimer = setInterval(() => {
      if (this.sseClients.size === 0) return;
      const keepalive = `: keepalive ${Date.now()}\n\n`;
      for (const client of this.sseClients) {
        this.writeToClient(client, keepalive);
      }
    }, this.heartbeatIntervalMs);

    // Don't keep process alive only because of heartbeat timer
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }
}
