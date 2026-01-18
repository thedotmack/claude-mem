/**
 * XML Parser Module
 * Parses observation and summary XML blocks from SDK responses
 *
 * Enhanced with structured parsing utilities for:
 * - Fault-tolerant extraction with fallbacks
 * - Parsing metrics and success rate tracking
 * - Better validation and error handling
 */

import { logger } from '../utils/logger.js';
import { ModeManager } from '../services/domain/ModeManager.js';
import {
  extractSection,
  extractEnum,
  extractList,
  extractAllBlocks,
  getParseMetrics,
  getParseSuccessRate,
  type ParseMetrics
} from '../utils/structured-parsing.js';

export interface ParsedObservation {
  type: string;
  title: string | null;
  subtitle: string | null;
  facts: string[];
  narrative: string | null;
  concepts: string[];
  files_read: string[];
  files_modified: string[];
}

export interface ParsedSummary {
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  notes: string | null;
}

// Re-export parsing metrics utilities
export { getParseMetrics, getParseSuccessRate, type ParseMetrics };

/**
 * Parse observation XML blocks from SDK response
 * Returns all observations found in the response
 *
 * Enhanced with structured parsing utilities for better fault tolerance
 * and metrics tracking.
 */
export function parseObservations(text: string, correlationId?: string): ParsedObservation[] {
  const observations: ParsedObservation[] = [];

  // Get valid types from active mode
  const mode = ModeManager.getInstance().getActiveMode();
  const validTypes = mode.observation_types.map(t => t.id);
  const fallbackType = validTypes[0]; // First type in mode's list is the fallback

  // Use extractAllBlocks for better block extraction
  const blocks = extractAllBlocks(text, 'observation');

  for (const block of blocks) {
    const obsContent = block.content;

    // Extract type with enum validation
    const typeResult = extractEnum(obsContent, 'type', validTypes, fallbackType);
    const finalType = typeResult.value;

    if (typeResult.fallbackUsed) {
      logger.warn('PARSER', `Observation type issue, using "${fallbackType}"`, {
        correlationId,
        extracted: typeResult.rawMatch
      });
    }

    // Extract other fields with fallback support
    const titleResult = extractSection(obsContent, 'title', '');
    const subtitleResult = extractSection(obsContent, 'subtitle', '');
    const narrativeResult = extractSection(obsContent, 'narrative', '');

    // Extract arrays
    const factsResult = extractList(obsContent, 'facts', 'fact', []);
    const conceptsResult = extractList(obsContent, 'concepts', 'concept', []);
    const filesReadResult = extractList(obsContent, 'files_read', 'file', []);
    const filesModifiedResult = extractList(obsContent, 'files_modified', 'file', []);

    // NOTE FROM THEDOTMACK: ALWAYS save observations - never skip. 10/24/2025
    // All fields except type are nullable in schema

    // Filter out type from concepts array (types and concepts are separate dimensions)
    const cleanedConcepts = conceptsResult.value.filter(c => c !== finalType);

    if (cleanedConcepts.length !== conceptsResult.value.length) {
      logger.warn('PARSER', 'Removed observation type from concepts array', {
        correlationId,
        type: finalType,
        originalConcepts: conceptsResult.value,
        cleanedConcepts
      });
    }

    observations.push({
      type: finalType,
      title: titleResult.value || null,
      subtitle: subtitleResult.value || null,
      facts: factsResult.value,
      narrative: narrativeResult.value || null,
      concepts: cleanedConcepts,
      files_read: filesReadResult.value,
      files_modified: filesModifiedResult.value
    });
  }

  // Log parsing metrics periodically
  const metrics = getParseMetrics();
  if (metrics.totalAttempts > 0 && metrics.totalAttempts % 100 === 0) {
    logger.info('PARSER', 'Parsing metrics checkpoint', {
      successRate: `${getParseSuccessRate().toFixed(1)}%`,
      total: metrics.totalAttempts,
      fallbacks: metrics.fallbacksUsed
    });
  }

  return observations;
}

/**
 * Parse summary XML block from SDK response
 * Returns null if no valid summary found or if summary was skipped
 *
 * Enhanced with structured parsing utilities for better fault tolerance.
 */
export function parseSummary(text: string, sessionId?: number): ParsedSummary | null {
  // Check for skip_summary first
  const skipRegex = /<skip_summary\s+reason="([^"]+)"\s*\/>/;
  const skipMatch = skipRegex.exec(text);

  if (skipMatch) {
    logger.info('PARSER', 'Summary skipped', {
      sessionId,
      reason: skipMatch[1]
    });
    return null;
  }

  // Use extractAllBlocks for consistent block extraction
  const blocks = extractAllBlocks(text, 'summary');

  if (blocks.length === 0) {
    return null;
  }

  const summaryContent = blocks[0].content;

  // Extract fields using structured parsing utilities
  const requestResult = extractSection(summaryContent, 'request', '');
  const investigatedResult = extractSection(summaryContent, 'investigated', '');
  const learnedResult = extractSection(summaryContent, 'learned', '');
  const completedResult = extractSection(summaryContent, 'completed', '');
  const nextStepsResult = extractSection(summaryContent, 'next_steps', '');
  const notesResult = extractSection(summaryContent, 'notes', ''); // Optional

  // NOTE FROM THEDOTMACK: 100% of the time we must SAVE the summary, even if fields are missing. 10/24/2025
  // NEVER DO THIS NONSENSE AGAIN.

  return {
    request: requestResult.value || null,
    investigated: investigatedResult.value || null,
    learned: learnedResult.value || null,
    completed: completedResult.value || null,
    next_steps: nextStepsResult.value || null,
    notes: notesResult.value || null
  };
}

// Legacy helper functions removed - now using structured-parsing.ts utilities
