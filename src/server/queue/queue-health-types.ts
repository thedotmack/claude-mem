// SPDX-License-Identifier: Apache-2.0

// Health schema for the server-beta BullMQ/Valkey observation queue, surfaced
// on /api/health so deploy probes (and the Docker E2E) can confirm the queue
// engine. `lanes` exposes per-queue counts (waiting/active/completed/failed/
// delayed/stalled) so probes can monitor saturation per lane. `unavailable:
// true` means the sample failed; the health endpoint MUST NOT 503 just because
// counts are stale.
//
// NOTE: the local SQLite worker no longer has an observation queue (it uses an
// in-RAM buffer), so only the server-beta runtime produces this shape.

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
