import { SettingsDefaultsManager } from '../../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../../shared/paths.js';
import { ModeManager } from '../../domain/ModeManager.js';
import { detectSource } from './detect.js';
import { extractItems } from './extract.js';
import { chunkText } from './chunk.js';
import { buildEatModel, digestChunk } from './digest.js';
import type { EatMcpConfig } from './connectors.js';
import type { EatChunk, EatObservationDraft, EatPipelineResult, EatSource } from './types.js';

export interface EatPipelineOptions {
  content?: string;
  recursive?: boolean;
  mcp?: EatMcpConfig;
}

export async function runEatPipeline(input: string | undefined, opts: EatPipelineOptions = {}): Promise<EatPipelineResult> {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
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

  const maxChunkChars = parseInt(settings.CLAUDE_MEM_EAT_MAX_CHUNK_CHARS, 10);
  const chunks: EatChunk[] = [];
  for (const item of extraction.items) {
    for (const text of chunkText(item.text, maxChunkChars)) {
      chunks.push({ index: chunks.length, text, source: item.source });
    }
  }

  const model = buildEatModel(settings);
  const modeTypes = ModeManager.getInstance().getActiveMode().observation_types.map(observationType => observationType.id);

  const drafts: EatObservationDraft[] = [];
  let servedModel = settings.CLAUDE_MEM_EAT_MODEL;
  for (const chunk of chunks) {
    const digest = await digestChunk(chunk, modeTypes, model);
    drafts.push(...digest.observations);
    servedModel = digest.model;
  }

  return { source, chunks: chunks.length, drafts, rejected: extraction.skipped, model: servedModel };
}
