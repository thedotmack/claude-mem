/**
 * PrinciplesRenderer - Renders active principles into context output
 *
 * Queries the principles store and formats confirmed/promoted principles
 * for injection into the context window above the timeline.
 */

import { SessionStore } from '../../sqlite/SessionStore.js';
import { getActivePrinciples } from '../../sqlite/principles/store.js';
import type { ContextConfig } from '../types.js';
import { logger } from '../../../utils/logger.js';

/**
 * Render principles section for context injection.
 * Returns empty array if no active principles or feature disabled.
 */
export function renderPrinciples(
  config: ContextConfig,
  useColors: boolean
): string[] {
  if (!config.principlesEnabled) return [];

  const maxInject = config.principlesMaxInject ?? 5;

  let db: SessionStore | null = null;
  try {
    db = new SessionStore();
    const principles = getActivePrinciples(db.db, maxInject);

    if (principles.length === 0) return [];

    const output: string[] = [];
    output.push('### Principles (User-Confirmed Rules)');

    for (const p of principles) {
      const confStr = p.confidence.toFixed(1);
      output.push(`- [${p.category}] ${p.rule} (confidence: ${confStr}, seen ${p.frequency}x)`);
    }

    output.push('');
    return output;
  } catch (error) {
    logger.debug('PRINCIPLES', 'Failed to render principles section', {}, error as Error);
    return [];
  } finally {
    db?.close();
  }
}
