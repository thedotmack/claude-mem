/**
 * XML Parser Module
 * Parses observation and summary XML blocks from SDK responses
 */

import { logger } from '../utils/logger.js';
import { ModeManager } from '../services/domain/ModeManager.js';
import type { ModeConfig } from '../services/domain/types.js';

export interface ParsedObservation {
  type: string;
  priority: 'critical' | 'important' | 'informational';
  title: string | null;
  subtitle: string | null;
  facts: string[];
  narrative: string | null;
  concepts: string[];
  files_read: string[];
  files_modified: string[];
  topics: string[];
  entities: Array<{ name: string; type: string }>;
  event_date: string | null;
}

export interface ParsedSummary {
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  notes: string | null;
}

/**
 * Parse observation XML blocks from SDK response
 * Returns all observations found in the response
 */
export function parseObservations(text: string, correlationId?: string): ParsedObservation[] {
  const observations: ParsedObservation[] = [];

  // Match <observation>...</observation> blocks (non-greedy)
  const observationRegex = /<observation>([\s\S]*?)<\/observation>/g;

  let match;
  while ((match = observationRegex.exec(text)) !== null) {
    const obsContent = match[1];

    // Extract all fields
    const type = extractField(obsContent, 'type');
    const rawPriority = extractField(obsContent, 'priority');
    const title = extractField(obsContent, 'title');
    const subtitle = extractField(obsContent, 'subtitle');
    const narrative = extractField(obsContent, 'narrative');
    const facts = extractArrayElements(obsContent, 'facts', 'fact');
    const concepts = extractArrayElements(obsContent, 'concepts', 'concept');
    const files_read = extractArrayElements(obsContent, 'files_read', 'file');
    const files_modified = extractArrayElements(obsContent, 'files_modified', 'file');

    // NOTE FROM THEDOTMACK: ALWAYS save observations - never skip. 10/24/2025
    // All fields except type are nullable in schema
    // If type is missing or invalid, use first type from mode as fallback

    // Determine final type using active mode's valid types
    const mode = ModeManager.getInstance().getActiveMode();
    const validTypes = mode.observation_types.map(t => t.id);
    const fallbackType = validTypes[0]; // First type in mode's list is the fallback
    let finalType = fallbackType;
    if (type) {
      if (validTypes.includes(type.trim())) {
        finalType = type.trim();
      } else {
        logger.error('PARSER', `Invalid observation type: ${type}, using "${fallbackType}"`, { correlationId });
      }
    } else {
      logger.error('PARSER', `Observation missing type field, using "${fallbackType}"`, { correlationId });
    }

    // All other fields are optional - save whatever we have

    // Validate and normalize concepts against mode's allowed concept IDs
    const validatedConcepts = validateConcepts(concepts, finalType, mode, correlationId);

    // Validate priority — must be one of the three valid values, default to 'informational'
    const VALID_PRIORITIES = ['critical', 'important', 'informational'] as const;
    type Priority = typeof VALID_PRIORITIES[number];
    const priority: Priority = rawPriority && VALID_PRIORITIES.includes(rawPriority as Priority)
      ? (rawPriority as Priority)
      : 'informational';

    observations.push({
      type: finalType,
      priority,
      title,
      subtitle,
      facts,
      narrative,
      concepts: validatedConcepts,
      files_read,
      files_modified
    });
  }

  return observations;
}

/**
 * Parse summary XML block from SDK response
 * Returns null if no valid summary found or if summary was skipped
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

  // Match <summary>...</summary> block (non-greedy)
  const summaryRegex = /<summary>([\s\S]*?)<\/summary>/;
  const summaryMatch = summaryRegex.exec(text);

  if (!summaryMatch) {
    return null;
  }

  const summaryContent = summaryMatch[1];

  // Extract fields
  const request = extractField(summaryContent, 'request');
  const investigated = extractField(summaryContent, 'investigated');
  const learned = extractField(summaryContent, 'learned');
  const completed = extractField(summaryContent, 'completed');
  const next_steps = extractField(summaryContent, 'next_steps');
  const notes = extractField(summaryContent, 'notes'); // Optional

  // Always save the summary even if fields are missing — partial summaries are
  // better than lost summaries. The storage layer handles empty-field guards.

  return {
    request,
    investigated,
    learned,
    completed,
    next_steps,
    notes
  };
}

/**
 * Validate and normalize concept values against the active mode's allowed concepts.
 * - Removes observation type from concepts (separate dimensions)
 * - Direct match against valid concept IDs
 * - Colon-prefix normalization: "how-it-works: long description" -> "how-it-works"
 * - Drops invalid concepts that don't match any valid value
 * - Deduplicates after normalization
 * - Infers a default concept from observation type if all were invalid
 */
export function validateConcepts(
  rawConcepts: string[],
  observationType: string,
  mode: ModeConfig,
  correlationId?: string
): string[] {
  const validConceptIds = new Set(mode.observation_concepts.map(c => c.id));

  // Step 1: Remove observation type from concepts (types and concepts are separate dimensions)
  const withoutType = rawConcepts.filter(c => c !== observationType);
  if (withoutType.length !== rawConcepts.length) {
    logger.debug('PARSER', 'Removed observation type from concepts array', {
      correlationId,
      type: observationType
    });
  }

  // Step 2: Validate each concept
  const validated: string[] = [];
  const dropped: string[] = [];

  for (const concept of withoutType) {
    const trimmed = concept.trim().toLowerCase();

    // Direct match
    if (validConceptIds.has(trimmed)) {
      validated.push(trimmed);
      continue;
    }

    // Colon-prefix normalization: "how-it-works: understanding the auth flow" -> "how-it-works"
    const colonIndex = trimmed.indexOf(':');
    if (colonIndex > 0) {
      const prefix = trimmed.substring(0, colonIndex).trim();
      if (validConceptIds.has(prefix)) {
        validated.push(prefix);
        continue;
      }
    }

    // No match — drop this concept
    dropped.push(concept);
  }

  // Step 3: Deduplicate (normalization may create dupes)
  const unique = [...new Set(validated)];

  // Step 4: Ensure at least 1 valid concept
  if (unique.length === 0) {
    const inferred = inferConceptFromType(observationType, mode);
    unique.push(inferred);
  }

  // Step 5: Log dropped concepts at debug level
  if (dropped.length > 0) {
    logger.debug('PARSER', `Dropped ${String(dropped.length)} invalid concept(s)`, {
      correlationId,
      dropped,
      kept: unique
    });
  }

  return unique;
}

/**
 * Infer a default concept from observation type when all concepts were invalid.
 * Maps each code-mode type to its most natural concept category.
 */
function inferConceptFromType(type: string, mode: ModeConfig): string {
  const typeToConceptMap: Record<string, string> = {
    'bugfix': 'problem-solution',
    'feature': 'what-changed',
    'refactor': 'what-changed',
    'change': 'what-changed',
    'discovery': 'how-it-works',
    'decision': 'trade-off',
  };

  const mapped = typeToConceptMap[type];
  if (mapped && mode.observation_concepts.some(c => c.id === mapped)) {
    return mapped;
  }

  // Fallback: first concept in the mode's list
  return mode.observation_concepts[0]?.id ?? 'what-changed';
}

/**
 * Extract a simple field value from XML content
 * Returns null for missing or empty/whitespace-only fields
 */
function extractField(content: string, fieldName: string): string | null {
  const regex = new RegExp(`<${fieldName}>([^<]*)</${fieldName}>`);
  const match = regex.exec(content);
  if (!match) return null;

  const trimmed = match[1].trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Extract array of elements from XML content
 */
function extractArrayElements(content: string, arrayName: string, elementName: string): string[] {
  const elements: string[] = [];

  // Match the array block
  const arrayRegex = new RegExp(`<${arrayName}>(.*?)</${arrayName}>`, 's');
  const arrayMatch = arrayRegex.exec(content);

  if (!arrayMatch) {
    return elements;
  }

  const arrayContent = arrayMatch[1];

  // Extract individual elements
  const elementRegex = new RegExp(`<${elementName}>([^<]+)</${elementName}>`, 'g');
  let elementMatch;
  while ((elementMatch = elementRegex.exec(arrayContent)) !== null) {
    elements.push(elementMatch[1].trim());
  }

  return elements;
}
