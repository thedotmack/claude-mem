// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from 'events';
import type { Database } from 'bun:sqlite';
import { SessionQueueProcessor, type CreateIteratorOptions } from '../../services/queue/SessionQueueProcessor.js';
import { PendingMessageStore } from '../../services/sqlite/PendingMessageStore.js';
import type { PendingMessage, PendingMessageWithId } from '../../services/worker-types.js';

export interface ObservationQueueEngine {
  enqueue(sessionDbId: number, contentSessionId: string, message: PendingMessage): Promise<number>;
  createIterator(options: CreateIteratorOptions): AsyncIterableIterator<PendingMessageWithId>;
  confirmProcessed(messageId: number): Promise<number>;
  clearPendingForSession(sessionDbId: number): Promise<number>;
  resetProcessingToPending(sessionDbId: number): Promise<number>;
  getPendingCount(sessionDbId: number): Promise<number>;
  getTotalQueueDepth(): Promise<number>;
  close(): Promise<void>;
}

// Phase 12 — `lanes` exposes per-queue counts (waiting/active/completed/
// failed/delayed/stalled) so deploy probes can monitor saturation per lane.
// `unavailable: true` means the sample failed; the health endpoint MUST NOT
// 503 just because counts are stale.
export interface ObservationQueueHealthLaneSnapshot {
  kind: string;
  name: string;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  stalled: number;
  unavailable: boolean;
  unavailableReason?: string;
}

export interface ObservationQueueHealth {
  engine: 'bullmq';
  redis: {
    status: 'ok' | 'error';
    mode: string;
    host: string;
    port: number;
    prefix: string;
    error?: string;
  };
  lanes?: ObservationQueueHealthLaneSnapshot[];
}

export interface ObservationQueueInspection {
  peekPendingTypes(sessionDbId: number): Promise<Array<{ message_type: string; tool_name: string | null }>>;
}

export type InspectableObservationQueueEngine = ObservationQueueEngine & ObservationQueueInspection;
export type HealthCheckedObservationQueueEngine = InspectableObservationQueueEngine & {
  getHealth(): Promise<ObservationQueueHealth>;
  assertHealthy(): Promise<void>;
};

export class SqliteObservationQueueEngine implements InspectableObservationQueueEngine {
  private readonly store: PendingMessageStore;
  private readonly eventsBySession = new Map<number, EventEmitter>();

  constructor(db: Database, onMutate?: () => void) {
    this.store = new PendingMessageStore(db, onMutate);
  }

  async enqueue(sessionDbId: number, contentSessionId: string, message: PendingMessage): Promise<number> {
    const id = this.store.enqueue(sessionDbId, contentSessionId, message);
    if (id > 0) {
      this.emit(sessionDbId);
    }
    return id;
  }

  createIterator(options: CreateIteratorOptions): AsyncIterableIterator<PendingMessageWithId> {
    const processor = new SessionQueueProcessor(this.store, this.getEvents(options.sessionDbId));
    return processor.createIterator(options);
  }

  async confirmProcessed(messageId: number): Promise<number> {
    return this.store.confirmProcessed(messageId);
  }

  async clearPendingForSession(sessionDbId: number): Promise<number> {
    const rows = this.store.clearPendingForSession(sessionDbId);
    if (rows > 0) {
      this.emit(sessionDbId);
    }
    return rows;
  }

  async resetProcessingToPending(sessionDbId: number): Promise<number> {
    const rows = this.store.resetProcessingToPending(sessionDbId);
    if (rows > 0) {
      this.emit(sessionDbId);
    }
    return rows;
  }

  async getPendingCount(sessionDbId: number): Promise<number> {
    return this.store.getPendingCount(sessionDbId);
  }

  async getTotalQueueDepth(): Promise<number> {
    return this.store.getTotalQueueDepth();
  }

  async peekPendingTypes(sessionDbId: number): Promise<Array<{ message_type: string; tool_name: string | null }>> {
    return this.store.peekPendingTypes(sessionDbId);
  }

  async close(): Promise<void> {
    for (const events of this.eventsBySession.values()) {
      events.removeAllListeners();
    }
    this.eventsBySession.clear();
  }

  private getEvents(sessionDbId: number): EventEmitter {
    let events = this.eventsBySession.get(sessionDbId);
    if (!events) {
      events = new EventEmitter();
      this.eventsBySession.set(sessionDbId, events);
    }
    return events;
  }

  private emit(sessionDbId: number): void {
    this.eventsBySession.get(sessionDbId)?.emit('message');
  }
}
