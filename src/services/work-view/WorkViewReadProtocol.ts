import type { WorkViewSnapshot } from './data-source.mjs';

/** Fixed labels only: diagnostics must never retain a request, path, or SQL parameter. */
export const WORK_VIEW_READ_PURPOSES = ['snapshot', 'http', 'event-initial', 'background', 'owner-state', 'owner-edit', 'rules', 'publish', 'shared-focus', 'overview', 'request-detail'] as const;
export type WorkViewReadPurpose = typeof WORK_VIEW_READ_PURPOSES[number];

/** Diagnostic durations are bounded, even for a broken clock or malformed worker reply. */
export const boundedDurationMs = (value: number): number => Number.isFinite(value) ? Math.min(86_400_000, Math.max(0, value)) : 0;

export interface WorkViewReadTiming {
  readMs: number;
}

export interface WorkViewReadDiagnostic extends WorkViewReadTiming {
  purpose: WorkViewReadPurpose;
  pendingAtEnqueue: number;
  /** Enqueue to started-notification receipt: includes startup/dispatch and may overlap readMs slightly. */
  queueWaitMs: number;
  roundTripMs: number;
  started: boolean;
  ok: boolean;
}

export interface WorkViewReaderDiagnostics {
  pendingCount: number;
  maxPendingCount: number;
  completedReads: number;
  failedReads: number;
  lastRead: WorkViewReadDiagnostic | null;
}

export type WorkViewReadResult = {
  agentView: WorkViewSnapshot;
  agentRevision: number;
};

export interface WorkViewReadRequest {
  id: number;
  maxActivityAgeMs: number;
  localDeviceId: string;
  kind?: 'view' | 'rules';
}
export type WorkViewReaderMessage = WorkViewReadRequest | { kind: 'invalidate-activity'; workState?: boolean };

export interface WorkViewRulesReadResult {
  rules: import('./my-rules.mjs').SavedRule[];
  source: { connected: boolean; error?: string | null; [key: string]: unknown };
}

export interface WorkViewReadStarted {
  id: number;
  started: true;
}

export interface WorkViewReadReply {
  id: number;
  ok: true;
  result: WorkViewReadResult;
  timing?: WorkViewReadTiming;
}

export interface WorkViewReadErrorReply {
  id: number;
  ok: false;
  error: { name: string; message: string };
  timing?: WorkViewReadTiming;
}

export type WorkViewReadResponse = WorkViewReadStarted | WorkViewReadReply | WorkViewReadErrorReply;
