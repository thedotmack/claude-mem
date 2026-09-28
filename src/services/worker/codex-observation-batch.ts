import { buildObservationPrompt, renderObservationPrompt, type ObservationPromptParts } from '../../sdk/prompts.js';
import { logger } from '../../utils/logger.js';
import type { PendingMessageWithId } from '../worker-types.js';
import { ClassifiedProviderError } from './provider-errors.js';

export function observationMetadata(message: PendingMessageWithId): string {
  return `Observation metadata: ${JSON.stringify({ pendingId: message._persistentId,
    timestamp: message._originalTimestamp, promptNumber: message.prompt_number,
    agentId: message.agentId, agentType: message.agentType, toolUseId: message.toolUseId })}\n`;
}

export function queuedObservationPrompt(message: PendingMessageWithId): string {
  return observationMetadata(message) + buildObservationPrompt({ id: message._persistentId,
    tool_name: message.tool_name!, tool_input: JSON.stringify(message.tool_input),
    tool_output: JSON.stringify(message.tool_response), created_at_epoch: message._originalTimestamp,
    cwd: message.cwd });
}

/** Keep structure and metadata; an exceptional oversized single item uses explicit elision. */
export function boundObservationPrompt(parts: ObservationPromptParts, maxChars: number, metadata = ''): string {
  const prompt = metadata + renderObservationPrompt(parts);
  if (prompt.length <= maxChars) return prompt;
  const shrinkField = (text: string, budget: number): string => {
    if (text.length <= budget) return text;
    const head = Math.floor(budget / 2);
    return `${text.slice(0, head)}<elided chars="${text.length - budget}" />${budget - head ? text.slice(-(budget - head)) : ''}`;
  };
  const shrink = (budget: number) => metadata + renderObservationPrompt({ ...parts,
    parameters: shrinkField(parts.parameters, budget), outcome: shrinkField(parts.outcome, budget) });
  if (shrink(0).length > maxChars) {
    throw new ClassifiedProviderError('Codex observation metadata exceeds batch character limit', { kind: 'transient', cause: null });
  }
  let low = 0, high = maxChars;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (shrink(mid).length <= maxChars) low = mid;
    else high = mid - 1;
  }
  const bounded = shrink(low);
  logger.debug('SDK', 'Codex observation elided to batch limit', { originalChars: prompt.length, boundedChars: bounded.length, maxChars });
  return bounded;
}

/** Storage has one attribution context per response, so changes are batch barriers. */
export function sameObservationContext(first: PendingMessageWithId, next: PendingMessageWithId): boolean {
  return next.type === 'observation' && first.prompt_number === next.prompt_number
    && first.agentId === next.agentId && first.agentType === next.agentType && first.cwd === next.cwd;
}
