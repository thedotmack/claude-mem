import { extractThinkingBlocks } from './thinking.js';
import { fetchWithTimeout, getWorkerPort, ensureWorkerRunning } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';
import { HOOK_TIMEOUTS, getTimeout } from '../../shared/hook-constants.js';
import type { ThoughtInput } from '../../services/sqlite/thoughts/types.js';

export interface ThoughtsExtractionInput {
  transcriptPath: string;
  sessionId: string;
  memorySessionId: string;
  project: string;
}

export interface ThoughtsExtractionResult {
  thoughtsStored: number;
}

const THOUGHTS_TIMEOUT_MS = getTimeout(HOOK_TIMEOUTS.DEFAULT);

/**
 * Extract thinking blocks from a transcript and store them via the worker API.
 * Called during the Stop hook to persist Claude's internal reasoning.
 */
export async function handleThoughtsExtraction(
  input: ThoughtsExtractionInput
): Promise<ThoughtsExtractionResult> {
  const blocks = extractThinkingBlocks(input.transcriptPath);

  if (blocks.length === 0) {
    logger.debug('THOUGHTS', 'No thinking blocks found in transcript', {
      transcriptPath: input.transcriptPath
    });
    return { thoughtsStored: 0 };
  }

  const thoughts: ThoughtInput[] = blocks.map(block => ({
    thinking_text: block.thinking,
    thinking_summary: null,
    message_index: block.messageIndex,
  }));

  logger.info('THOUGHTS', `Extracted ${thoughts.length} thinking blocks, sending to worker`, {
    contentSessionId: input.sessionId,
    project: input.project
  });

  const workerReady = await ensureWorkerRunning();
  if (!workerReady) {
    logger.warn('THOUGHTS', 'Worker not available, skipping thought storage');
    return { thoughtsStored: 0 };
  }

  const port = getWorkerPort();
  const response = await fetchWithTimeout(
    `http://127.0.0.1:${port}/api/sessions/thoughts`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        memorySessionId: input.memorySessionId,
        contentSessionId: input.sessionId,
        project: input.project,
        thoughts,
      }),
    },
    THOUGHTS_TIMEOUT_MS
  );

  if (!response.ok) {
    const text = await response.text();
    logger.warn('THOUGHTS', 'Failed to store thoughts', {
      status: response.status,
      body: text
    });
    return { thoughtsStored: 0 };
  }

  const result = await response.json() as { ids: number[] };
  logger.info('THOUGHTS', `Stored ${result.ids.length} thoughts`, {
    contentSessionId: input.sessionId
  });

  return { thoughtsStored: result.ids.length };
}
