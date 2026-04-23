/**
 * XML Parser Module
 *
 * Single fail-fast entry point for SDK agent XML responses.
 *
 * Per PATHFINDER-2026-04-22 plan 03 phase 1:
 * - One function (`parseAgentXml`) for all agent responses.
 * - Discriminated-union return: `{ valid: true, kind, data }` or `{ valid: false, reason }`.
 * - No coercion. No silent passthrough. No "lenient mode".
 * - `<skip_summary reason="…"/>` is a first-class summary case (skipped: true).
 */

import { logger } from '../utils/logger.js';
import { ModeManager } from '../services/domain/ModeManager.js';

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
  /** True when the response was an explicit `<skip_summary reason="…"/>` bypass. */
  skipped?: boolean;
  /** Non-null when `skipped: true`. */
  skip_reason?: string | null;
}

export type ParseResult =
  | { valid: true; kind: 'observation'; data: ParsedObservation[] }
  | { valid: true; kind: 'summary'; data: ParsedSummary }
  | { valid: false; reason: string };

/**
 * Parse an SDK agent response. Inspects the first significant XML root element
 * and returns a discriminated union. Never coerces. Never returns null/undefined.
 *
 * Recognised roots:
 *   <observation> … </observation>      → { kind: 'observation', data: ParsedObservation[] }
 *   <summary> … </summary>              → { kind: 'summary', data: ParsedSummary }
 *   <skip_summary reason="…" />         → { kind: 'summary', data: { skipped: true, … } }
 *
 * Anything else → { valid: false, reason }. The caller is responsible for
 * surfacing the reason (markFailed, log, etc.). No retry coercion.
 */
export function parseAgentXml(raw: string, correlationId?: string | number): ParseResult {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { valid: false, reason: 'empty: response had no content' };
  }

  // Skip-summary is recognised even when wrapped in other text, but only as the
  // sole structural signal. It outranks <observation> / <summary> matches because
  // it is an explicit protocol bypass. `reason` is optional.
  const skipMatch = /<skip_summary(?:\s+reason="([^"]*)")?\s*\/>/.exec(raw);
  if (skipMatch) {
    return {
      valid: true,
      kind: 'summary',
      data: {
        request: null,
        investigated: null,
        learned: null,
        completed: null,
        next_steps: null,
        notes: null,
        skipped: true,
        skip_reason: skipMatch[1] ?? null,
      },
    };
  }

  // Find the first significant element by scanning for the first `<…>` opener
  // that is one of the recognised roots. This tolerates leading prose / debug
  // output from the model while still failing fast on entirely-non-XML payloads.
  const firstRoot = /<(observation|summary)\b/i.exec(raw);
  if (!firstRoot) {
    const preview = raw.length > 120 ? `${raw.slice(0, 120)}…` : raw;
    return {
      valid: false,
      reason: `unknown root: response contained no <observation>, <summary>, or <skip_summary/> element (preview: ${preview.replace(/\s+/g, ' ')})`,
    };
  }

  const rootName = firstRoot[1].toLowerCase();
  if (rootName === 'observation') {
    const observations = parseObservationBlocks(raw, correlationId);
    if (observations.length === 0) {
      return {
        valid: false,
        reason: '<observation>: no parseable observation block (every block was empty or ghost)',
      };
    }
    return { valid: true, kind: 'observation', data: observations };
  }

  // rootName === 'summary'
  const summary = parseSummaryBlock(raw, correlationId);
  if (!summary) {
    return {
      valid: false,
      reason: '<summary>: empty or missing every required sub-tag (request/investigated/learned/completed/next_steps)',
    };
  }
  return { valid: true, kind: 'summary', data: summary };
}

/**
 * Parse all <observation>…</observation> blocks. Filters out ghost
 * observations (every content field empty). Returns the surviving list.
 */
function parseObservationBlocks(text: string, correlationId?: string | number): ParsedObservation[] {
  const observations: ParsedObservation[] = [];

  const observationRegex = /<observation>([\s\S]*?)<\/observation>/g;

  let match;
  while ((match = observationRegex.exec(text)) !== null) {
    const obsContent = match[1];

    const type = extractField(obsContent, 'type');
    const title = extractField(obsContent, 'title');
    const subtitle = extractField(obsContent, 'subtitle');
    const narrative = extractField(obsContent, 'narrative');
    const facts = extractArrayElements(obsContent, 'facts', 'fact');
    const concepts = extractArrayElements(obsContent, 'concepts', 'concept');
    const files_read = extractArrayElements(obsContent, 'files_read', 'file');
    const files_modified = extractArrayElements(obsContent, 'files_modified', 'file');

    // Type fallback: per existing semantics, missing/invalid type degrades to the
    // first type in the active mode. This is parser-internal validation, not
    // recovery from a contract violation: every mode's first type is intentionally
    // the catch-all bucket.
    const mode = ModeManager.getInstance().getActiveMode();
    const validTypes = mode.observation_types.map(t => t.id);
    const fallbackType = validTypes[0];
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

    // Filter out type from concepts array (types and concepts are separate dimensions)
    const cleanedConcepts = concepts.filter(c => c !== finalType);

    if (cleanedConcepts.length !== concepts.length) {
      logger.debug('PARSER', 'Removed observation type from concepts array', {
        correlationId,
        type: finalType,
        originalConcepts: concepts,
        cleanedConcepts
      });
    }

    // Skip ghost observations — records where every content field is null/empty.
    // (subtitle and file lists are intentionally excluded from this guard:
    // an observation with only a subtitle is still too thin to be useful.)
    if (!title && !narrative && facts.length === 0 && cleanedConcepts.length === 0) {
      logger.warn('PARSER', 'Skipping empty observation (all content fields null)', {
        correlationId,
        type: finalType
      });
      continue;
    }

    observations.push({
      type: finalType,
      title,
      subtitle,
      facts,
      narrative,
      concepts: cleanedConcepts,
      files_read,
      files_modified
    });
  }

  return observations;
}

/**
 * Parse a single <summary>…</summary> block. Returns null when the block has
 * no usable sub-tags (every required field empty) — the caller maps this to
 * a fail-fast `{ valid: false, reason }` result.
 */
function parseSummaryBlock(text: string, correlationId?: string | number): ParsedSummary | null {
  const summaryRegex = /<summary>([\s\S]*?)<\/summary>/;
  const summaryMatch = summaryRegex.exec(text);
  if (!summaryMatch) return null;

  const summaryContent = summaryMatch[1];

  const request = extractField(summaryContent, 'request');
  const investigated = extractField(summaryContent, 'investigated');
  const learned = extractField(summaryContent, 'learned');
  const completed = extractField(summaryContent, 'completed');
  const next_steps = extractField(summaryContent, 'next_steps');
  const notes = extractField(summaryContent, 'notes'); // optional

  // Per maintainer note: a summary with at least one populated sub-tag must be
  // saved. Missing sub-tags are tolerated; an entirely empty <summary> block is
  // a false-positive (covered the #1360 regression) and is rejected.
  if (!request && !investigated && !learned && !completed && !next_steps) {
    logger.warn('PARSER', 'Summary block has no sub-tags — rejecting false positive', { correlationId });
    return null;
  }

  return {
    request,
    investigated,
    learned,
    completed,
    next_steps,
    notes,
  };
}

/**
 * Extract a simple field value from XML content
 * Returns null for missing or empty/whitespace-only fields
 *
 * Uses non-greedy match to handle nested tags and code snippets (Issue #798)
 */
function extractField(content: string, fieldName: string): string | null {
  const regex = new RegExp(`<${fieldName}>([\\s\\S]*?)</${fieldName}>`);
  const match = regex.exec(content);
  if (!match) return null;

  const trimmed = match[1].trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Extract array of elements from XML content
 * Handles nested tags and code snippets (Issue #798)
 */
function extractArrayElements(content: string, arrayName: string, elementName: string): string[] {
  const elements: string[] = [];

  const arrayRegex = new RegExp(`<${arrayName}>([\\s\\S]*?)</${arrayName}>`);
  const arrayMatch = arrayRegex.exec(content);

  if (!arrayMatch) {
    return elements;
  }

  const arrayContent = arrayMatch[1];

  const elementRegex = new RegExp(`<${elementName}>([\\s\\S]*?)</${elementName}>`, 'g');
  let elementMatch;
  while ((elementMatch = elementRegex.exec(arrayContent)) !== null) {
    const trimmed = elementMatch[1].trim();
    if (trimmed) {
      elements.push(trimmed);
    }
  }

  return elements;
}
