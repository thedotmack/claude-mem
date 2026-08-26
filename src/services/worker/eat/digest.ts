import { generateText, Output, type LanguageModel } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { z } from 'zod';
import { getCredential } from '../../../shared/EnvManager.js';
import { logger } from '../../../utils/logger.js';
import type { SettingsDefaults } from '../../../shared/SettingsDefaultsManager.js';
import { EatError } from './errors.js';
import type { EatChunk, EatDigestResult } from './types.js';

export function buildEatModel(settings: SettingsDefaults): LanguageModel {
  const apiKey = settings.CLAUDE_MEM_OPENROUTER_API_KEY || getCredential('OPENROUTER_API_KEY') || '';
  if (apiKey) {
    return createOpenRouter({ apiKey })(settings.CLAUDE_MEM_EAT_MODEL);
  }
  if (process.env.AI_GATEWAY_API_KEY) {
    return settings.CLAUDE_MEM_EAT_MODEL;
  }
  throw new EatError(
    'digest_failed',
    'No EAT model credentials: set the CLAUDE_MEM_OPENROUTER_API_KEY credential (~/.claude-mem/.env or settings) or the AI_GATEWAY_API_KEY env var'
  );
}

function buildDigestSchema(modeTypes: string[]) {
  return z.object({
    observations: z.array(z.object({
      type: z.enum(modeTypes as [string, ...string[]]),
      title: z.string(),
      subtitle: z.string(),
      facts: z.array(z.string()),
      narrative: z.string(),
      concepts: z.array(z.string()),
    })),
  });
}

export async function digestChunk(chunk: EatChunk, modeTypes: string[], model: LanguageModel): Promise<EatDigestResult> {
  const { output } = await generateText({
    model,
    output: Output.object({ schema: buildDigestSchema(modeTypes) }),
    prompt: `You are EAT, claude-mem's ingester. Extract durable, useful observations from this content. Source: ${chunk.source.locator}.\n\n${chunk.text}`,
    maxOutputTokens: 8_000,
  });
  const modelId = typeof model === 'string' ? model : model.modelId;
  logger.debug('INGEST', 'EAT chunk digested', { chunk_index: chunk.index, observations: output.observations.length, model: modelId });
  return { observations: output.observations, model: modelId };
}
