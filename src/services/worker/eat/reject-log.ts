import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { EAT_REJECTED_LOG_PATH } from '../../../shared/paths.js';
import { logger } from '../../../utils/logger.js';
import type { EatSource } from './types.js';

export interface EatRejectEntry {
  ts: string;
  request_id: string;
  source: EatSource;
  reason: string;
  chunk_index?: number;
}

/**
 * Append one JSONL line to ~/.claude-mem/eat-rejected.jsonl (memorable's
 * ~/.memorable/rejected.jsonl convention). Reject logging must never take
 * down a run: a failed append degrades to a logger warning and the pipeline
 * continues.
 */
export function appendEatReject(entry: EatRejectEntry): void {
  try {
    mkdirSync(dirname(EAT_REJECTED_LOG_PATH), { recursive: true });
    appendFileSync(EAT_REJECTED_LOG_PATH, `${JSON.stringify(entry)}\n`);
  } catch (error) {
    logger.warn('INGEST', 'EAT reject log append failed', { path: EAT_REJECTED_LOG_PATH }, error as Error);
  }
}
