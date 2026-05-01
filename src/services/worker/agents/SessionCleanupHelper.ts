
import type { ActiveSession } from '../../worker-types.js';
import { logger } from '../../../utils/logger.js';
import type { WorkerRef } from './types.js';

export function cleanupProcessedMessages(
  session: ActiveSession,
  worker: WorkerRef | undefined
): void {
  session.earliestPendingTimestamp = null;
}
