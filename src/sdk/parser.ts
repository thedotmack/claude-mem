
import { logger } from '../utils/logger.js';
import { ModeManager } from '../services/domain/ModeManager.js';

// TODO(#2233): migrate to Anthropic tool-use API for deterministic JSON output. This text-XML path is the bridge.
// Only strip fences when the entire payload is a single fenced block. Stripping
// the first opening + last closing fence anywhere in the string can corrupt
// content that contains internal fenced examples or surrounding prose
// (CodeRabbit review on PR #2282).
function stripCodeFences(text: string): string {
  const match = text.match(/^\s*```(?:xml)?\s*\n([\s\S]*?)\n```\s*$/i);
  return match ? match[1] : text;
}

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
  skipped?: boolean;
  skip_reason?: string | null;
}

export type ParseResult =
  | { valid: true; observations: ParsedObservation[]; summary: ParsedSummary | null }
  | { valid: false };

export function parseAgentXml(raw: string, correlationId?: string | number): ParseResult {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { valid: false };
  }

  raw = stripCodeFences(raw);

  const skipMatch = /<skip_summary(?:\s+reason="([^"]*)")?\s*\/>/.exec(raw);
  if (skipMatch) {
    return {
      valid: true,
      observations: [],
      summary: {
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

  const firstRoot = /<(observation|summary)\b/i.exec(raw);
  if (!firstRoot) {
    return { valid: false };
  }

  const rootName = firstRoot[1].toLowerCase();
  if (rootName === 'observation') {
    const observations = parseObservationBlocks(raw, correlationId);
    if (observations.length === 0) {
      return { valid: false };
    }
    return { valid: true, observations, summary: null };
  }

  const summary = parseSummaryBlock(raw, correlationId);
  if (!summary) {
    return { valid: false };
  }
  return { valid: true, observations: [], summary };
}

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

    const cleanedConcepts = concepts.filter(c => c !== finalType);

    if (cleanedConcepts.length !== concepts.length) {
      logger.debug('PARSER', 'Removed observation type from concepts array', {
        correlationId,
        type: finalType,
        originalConcepts: concepts,
        cleanedConcepts
      });
    }

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
  const notes = extractField(summaryContent, 'notes'); 

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

function extractField(content: string, fieldName: string): string | null {
  const regex = new RegExp(`<${fieldName}>([\\s\\S]*?)</${fieldName}>`);
  const match = regex.exec(content);
  if (!match) return null;

  const trimmed = match[1].trim();
  return trimmed === '' ? null : trimmed;
}

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
