import type { LedgerDatabase, RefreshNeeds } from './request-groups.mjs';

export type RefreshState = 'idle' | 'running' | 'ok' | 'failed' | 'waiting-for-agent';
export interface RefreshStepTiming { step: string; agent: string; startedAt: string; finishedAt: string; groups?: number }
export interface RefreshJobOutcome { state: 'ok' | 'failed' | 'waiting-for-agent'; agent: string | null; result: string | null; error: string | null; steps?: RefreshStepTiming[] }
export interface RefreshStatus {
  state: RefreshState;
  reason?: string;
  agent?: string | null;
  startedAt?: string;
  finishedAt?: string;
  checkedAt?: string;
  nextAt?: string | null;
  /** null when the run failed before it could read what was due. */
  needs?: RefreshNeeds | null;
  result?: string | null;
  error?: string | null;
  steps?: RefreshStepTiming[];
  /** Failed runs in a row; the next scheduled check waits longer for each. Absent after a run that works. */
  failures?: number;
}

/** Milliseconds between scheduled checks for a CLAUDE_MEM_WORK_VIEW_REFRESH_INTERVAL_MIN value; invalid input gives ten minutes. */
export function refreshIntervalMs(minutes: string | number | null | undefined): number;

export class AutoRefreshWorker {
  constructor(options: {
    dir: string;
    openDatabase: () => LedgerDatabase & { close(): void };
    runJob: (job: { needs: RefreshNeeds; reason: string }) => Promise<RefreshJobOutcome>;
    enabled?: () => boolean;
    setupRunning?: () => boolean;
    checkMs?: number;
    now?: () => number;
    log?: (level: 'info' | 'warn', message: string, data?: Record<string, unknown>) => void;
    /** The worker's sync device id ('' when cloud sync never started), so my-focus rows replay in its order. */
    localDeviceId: () => string;
  });
  /** True from the moment a run starts until it finishes. */
  readonly busy: boolean;
  status(): RefreshStatus | null;
  start(): void;
  close(): void;
  check(): Promise<'closed' | 'disabled' | 'running' | 'backing-off' | 'idle' | RefreshJobOutcome['state']>;
  runNow(options: { reason: string }): Promise<'closed' | 'setup-running' | 'running' | 'idle' | RefreshJobOutcome['state']>;
}
