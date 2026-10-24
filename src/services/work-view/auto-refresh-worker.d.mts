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
  needs?: RefreshNeeds;
  result?: string | null;
  error?: string | null;
  steps?: RefreshStepTiming[];
}

export class AutoRefreshWorker {
  constructor(options: {
    dir: string;
    openDatabase: () => LedgerDatabase & { close(): void };
    runJob: (job: { needs: RefreshNeeds; reason: string }) => Promise<RefreshJobOutcome>;
    enabled?: () => boolean;
    checkMs?: number;
    now?: () => number;
    log?: (level: 'info' | 'warn', message: string, data?: Record<string, unknown>) => void;
  });
  status(): RefreshStatus | null;
  start(): void;
  close(): void;
  check(): Promise<'closed' | 'disabled' | 'running' | 'idle' | RefreshJobOutcome['state']>;
  runNow(options: { reason: string }): Promise<'closed' | 'running' | 'idle' | RefreshJobOutcome['state']>;
}
