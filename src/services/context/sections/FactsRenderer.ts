
import type { SemanticFact } from '../types.js';

/**
 * Semantic memory layer — the `## Project Knowledge` block: durable facts
 * rendered above the observations timeline, one compact line each. Identical
 * for agent and human output; empty when there is nothing active.
 */
export function renderFactsBlock(facts: SemanticFact[]): string[] {
  if (facts.length === 0) return [];

  const output: string[] = ['## Project Knowledge', ''];
  for (const fact of facts) {
    output.push(`- #${fact.id} [${fact.kind}] ${fact.fact}`);
  }
  output.push('');
  return output;
}
