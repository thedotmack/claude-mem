import { randomUUID } from 'crypto';
import { SettingsDefaultsManager } from '../../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../../shared/paths.js';
import { logger } from '../../../utils/logger.js';
import { ModeManager } from '../../domain/ModeManager.js';
import { detectSource } from './detect.js';
import { extractItems } from './extract.js';
import { chunkText } from './chunk.js';
import { buildEatModel, digestChunk } from './digest.js';
import { EatError } from './errors.js';
import { appendEatReject } from './reject-log.js';
import type { EatMcpConfig } from './connectors.js';
import type { EatChunk, EatObservationDraft, EatPipelineResult, EatSource } from './types.js';

export interface EatPipelineOptions {
  content?: string;
  recursive?: boolean;
  mcp?: EatMcpConfig;
  requestId?: string;
}

export async function runEatPipeline(input: string | undefined, opts: EatPipelineOptions = {}): Promise<EatPipelineResult> {
  const requestId = opts.requestId ?? randomUUID();
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  // Fail fast on missing credentials — before any fetch work happens.
  const model = buildEatModel(settings);
  // Connectors are declared, not sniffed — an mcp config bypasses detection.
  const source: EatSource = opts.mcp !== undefined
    ? { kind: 'mcp', locator: opts.mcp.url }
    : detectSource(input, opts.content !== undefined);
  const extraction = await extractItems(source, {
    fetchTimeoutMs: parseInt(settings.CLAUDE_MEM_EAT_FETCH_TIMEOUT_MS, 10),
    recursive: opts.recursive,
    stdinText: opts.content,
    mcp: opts.mcp,
  });

  for (const reject of extraction.rejects) {
    appendEatReject({ ts: new Date().toISOString(), request_id: requestId, source: reject.source, reason: reject.reason });
  }

  // "Some items failed" degrades gracefully; "nothing extracted at all" is an
  // error, never an empty success.
  if (extraction.items.length === 0 && extraction.rejects.length > 0) {
    const code = source.kind === 'url' || source.kind === 'feed' || source.kind === 'mcp'
      ? 'upstream_fetch_failed'
      : 'invalid_request';
    throw new EatError(code, `Nothing extracted from ${source.locator}: ${extraction.rejects[0].reason}`);
  }

  const maxChunkChars = parseInt(settings.CLAUDE_MEM_EAT_MAX_CHUNK_CHARS, 10);
  const chunks: EatChunk[] = [];
  for (const item of extraction.items) {
    for (const text of chunkText(item.text, maxChunkChars)) {
      chunks.push({ index: chunks.length, text, source: item.source });
    }
  }

  const modeTypes = ModeManager.getInstance().getActiveMode().observation_types.map(observationType => observationType.id);

  const drafts: EatObservationDraft[] = [];
  let servedModel = settings.CLAUDE_MEM_EAT_MODEL;
  let rejected = extraction.rejects.length;
  let digestFailures = 0;
  let lastDigestFailure = '';
  for (const chunk of chunks) {
    try {
      const digest = await digestChunk(chunk, modeTypes, model);
      drafts.push(...digest.observations);
      servedModel = digest.model;
    } catch (error) {
      // Per-chunk boundary (memorable's graceful degradation): a model/schema
      // failure sends the chunk to the reject log and the run continues.
      const reason = error instanceof Error ? error.message : String(error);
      rejected++;
      digestFailures++;
      lastDigestFailure = reason;
      logger.warn('INGEST', 'EAT chunk digest failed', { request_id: requestId, chunk_index: chunk.index, reason });
      appendEatReject({ ts: new Date().toISOString(), request_id: requestId, source: chunk.source, reason, chunk_index: chunk.index });
    }
  }

  // Every chunk failing means the model is unusable — surface it, don't
  // pretend an empty digest succeeded.
  if (chunks.length > 0 && digestFailures === chunks.length) {
    throw new EatError('digest_failed', `All ${chunks.length} chunk(s) failed to digest: ${lastDigestFailure}`);
  }

  return { source, chunks: chunks.length, drafts, rejected, model: servedModel };
}
