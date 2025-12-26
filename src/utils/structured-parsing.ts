/**
 * Structured Parsing Utilities for claude-mem
 *
 * Enhanced parsing functions with:
 * - Fault-tolerant extraction with configurable fallbacks
 * - Type-safe validation with enum support
 * - Parsing metrics and success tracking
 * - Flexible section marker matching
 *
 * Based on pipeline architecture analysis recommendations.
 */

import { logger } from './logger';

// ============================================================================
// Types
// ============================================================================

export interface ParseResult<T> {
  value: T;
  success: boolean;
  fallbackUsed: boolean;
  rawMatch?: string;
}

export interface ParseMetrics {
  totalAttempts: number;
  successfulExtractions: number;
  fallbacksUsed: number;
  failures: number;
  fieldMetrics: Record<string, FieldMetrics>;
}

export interface FieldMetrics {
  attempts: number;
  successes: number;
  fallbacks: number;
  failures: number;
}

// ============================================================================
// Metrics Tracking
// ============================================================================

let metrics: ParseMetrics = {
  totalAttempts: 0,
  successfulExtractions: 0,
  fallbacksUsed: 0,
  failures: 0,
  fieldMetrics: {}
};

function trackMetric(field: string, result: 'success' | 'fallback' | 'failure'): void {
  metrics.totalAttempts++;

  if (!metrics.fieldMetrics[field]) {
    metrics.fieldMetrics[field] = { attempts: 0, successes: 0, fallbacks: 0, failures: 0 };
  }

  metrics.fieldMetrics[field].attempts++;

  switch (result) {
    case 'success':
      metrics.successfulExtractions++;
      metrics.fieldMetrics[field].successes++;
      break;
    case 'fallback':
      metrics.fallbacksUsed++;
      metrics.fieldMetrics[field].fallbacks++;
      break;
    case 'failure':
      metrics.failures++;
      metrics.fieldMetrics[field].failures++;
      break;
  }
}

export function getParseMetrics(): ParseMetrics {
  return { ...metrics };
}

export function resetParseMetrics(): void {
  metrics = {
    totalAttempts: 0,
    successfulExtractions: 0,
    fallbacksUsed: 0,
    failures: 0,
    fieldMetrics: {}
  };
}

export function getParseSuccessRate(): number {
  if (metrics.totalAttempts === 0) return 100;
  return ((metrics.successfulExtractions + metrics.fallbacksUsed) / metrics.totalAttempts) * 100;
}

// ============================================================================
// Core Extraction Functions
// ============================================================================

/**
 * Extract a single field from content using XML-style tags.
 * Supports both simple tags and tags with attributes.
 *
 * @param content - The content to extract from
 * @param fieldName - The XML tag name to find
 * @param fallback - Default value if extraction fails
 * @returns ParseResult with extracted value or fallback
 */
export function extractSection<T extends string>(
  content: string,
  fieldName: string,
  fallback: T
): ParseResult<T> {
  // Try standard XML tag first
  const simpleRegex = new RegExp(`<${fieldName}>([\\s\\S]*?)</${fieldName}>`, 'i');
  let match = simpleRegex.exec(content);

  // Try with potential whitespace/newlines
  if (!match) {
    const flexibleRegex = new RegExp(`<${fieldName}[^>]*>\\s*([\\s\\S]*?)\\s*</${fieldName}>`, 'i');
    match = flexibleRegex.exec(content);
  }

  // Try markdown-style section headers as fallback (## FIELDNAME)
  if (!match) {
    const markdownRegex = new RegExp(`##\\s*${fieldName}[\\s\\n]+([^#]+?)(?=##|$)`, 'i');
    match = markdownRegex.exec(content);
  }

  if (match && match[1]) {
    const trimmed = match[1].trim();
    if (trimmed !== '' && !trimmed.startsWith('[') && !trimmed.endsWith(']')) {
      trackMetric(fieldName, 'success');
      return {
        value: trimmed as T,
        success: true,
        fallbackUsed: false,
        rawMatch: match[0]
      };
    }
  }

  // Fallback
  trackMetric(fieldName, 'fallback');
  logger.debug('PARSER', `Using fallback for field: ${fieldName}`, { fallback });

  return {
    value: fallback,
    success: false,
    fallbackUsed: true,
    rawMatch: undefined
  };
}

/**
 * Extract a field and validate against allowed enum values.
 *
 * @param content - The content to extract from
 * @param fieldName - The XML tag name to find
 * @param validValues - Array of valid values
 * @param fallback - Default value if extraction fails or value is invalid
 * @returns ParseResult with validated value or fallback
 */
export function extractEnum<T extends string>(
  content: string,
  fieldName: string,
  validValues: readonly T[],
  fallback: T
): ParseResult<T> {
  const result = extractSection(content, fieldName, fallback);

  if (result.success) {
    const normalizedValue = result.value.toLowerCase().trim() as T;
    const matchedValue = validValues.find(v =>
      v.toLowerCase() === normalizedValue ||
      normalizedValue.includes(v.toLowerCase())
    );

    if (matchedValue) {
      return {
        value: matchedValue,
        success: true,
        fallbackUsed: false,
        rawMatch: result.rawMatch
      };
    }

    // Value extracted but not in valid list
    trackMetric(`${fieldName}_validation`, 'fallback');
    logger.warn('PARSER', `Invalid enum value for ${fieldName}: "${result.value}", using fallback`, {
      validValues,
      fallback
    });

    return {
      value: fallback,
      success: false,
      fallbackUsed: true,
      rawMatch: result.rawMatch
    };
  }

  return result;
}

/**
 * Extract a list from an array container with element tags.
 *
 * @param content - The content to extract from
 * @param arrayName - The container tag name (e.g., 'facts', 'files_read')
 * @param elementName - The individual element tag name (e.g., 'fact', 'file')
 * @param fallback - Default array if extraction fails
 * @returns ParseResult with extracted array or fallback
 */
export function extractList(
  content: string,
  arrayName: string,
  elementName: string,
  fallback: string[] = []
): ParseResult<string[]> {
  // Find the container
  const containerRegex = new RegExp(`<${arrayName}>([\\s\\S]*?)</${arrayName}>`, 'i');
  const containerMatch = containerRegex.exec(content);

  if (!containerMatch) {
    trackMetric(arrayName, 'fallback');
    return {
      value: fallback,
      success: false,
      fallbackUsed: true,
      rawMatch: undefined
    };
  }

  const containerContent = containerMatch[1];
  const elements: string[] = [];

  // Extract elements
  const elementRegex = new RegExp(`<${elementName}>([^<]+)</${elementName}>`, 'gi');
  let elementMatch;

  while ((elementMatch = elementRegex.exec(containerContent)) !== null) {
    const trimmed = elementMatch[1].trim();
    // Skip placeholder values
    if (trimmed && !trimmed.startsWith('[') && !trimmed.endsWith(']')) {
      elements.push(trimmed);
    }
  }

  if (elements.length > 0) {
    trackMetric(arrayName, 'success');
    return {
      value: elements,
      success: true,
      fallbackUsed: false,
      rawMatch: containerMatch[0]
    };
  }

  trackMetric(arrayName, 'fallback');
  return {
    value: fallback,
    success: false,
    fallbackUsed: true,
    rawMatch: containerMatch[0]
  };
}

/**
 * Extract a numeric score with range validation.
 *
 * @param content - The content to extract from
 * @param fieldName - The XML tag name to find
 * @param min - Minimum valid value
 * @param max - Maximum valid value
 * @param fallback - Default value if extraction fails or out of range
 * @returns ParseResult with validated number or fallback
 */
export function extractScore(
  content: string,
  fieldName: string,
  min: number,
  max: number,
  fallback: number
): ParseResult<number> {
  const result = extractSection(content, fieldName, String(fallback));

  if (result.success) {
    const parsed = parseFloat(result.value);

    if (!isNaN(parsed) && parsed >= min && parsed <= max) {
      trackMetric(fieldName, 'success');
      return {
        value: parsed,
        success: true,
        fallbackUsed: false,
        rawMatch: result.rawMatch
      };
    }

    // Value extracted but invalid
    trackMetric(`${fieldName}_validation`, 'fallback');
    logger.warn('PARSER', `Invalid score for ${fieldName}: "${result.value}" (expected ${min}-${max})`, {
      fallback
    });
  }

  return {
    value: fallback,
    success: false,
    fallbackUsed: true,
    rawMatch: result.rawMatch
  };
}

// ============================================================================
// Batch Parsing Utilities
// ============================================================================

export interface ParsedBlock {
  content: string;
  startIndex: number;
  endIndex: number;
}

/**
 * Extract all blocks matching a pattern from content.
 * Useful for extracting multiple observations from a response.
 *
 * @param content - The content to extract from
 * @param blockName - The block tag name (e.g., 'observation')
 * @returns Array of parsed blocks with their positions
 */
export function extractAllBlocks(content: string, blockName: string): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  const regex = new RegExp(`<${blockName}>([\\s\\S]*?)</${blockName}>`, 'gi');

  let match;
  while ((match = regex.exec(content)) !== null) {
    blocks.push({
      content: match[1],
      startIndex: match.index,
      endIndex: match.index + match[0].length
    });
  }

  return blocks;
}

// ============================================================================
// Validation Utilities
// ============================================================================

/**
 * Validate that required fields are present in parsed data.
 *
 * @param data - Object to validate
 * @param requiredFields - Array of required field names
 * @returns Object with validation result and missing fields
 */
export function validateRequiredFields(
  data: Record<string, unknown>,
  requiredFields: string[]
): { valid: boolean; missing: string[] } {
  const missing: string[] = [];

  for (const field of requiredFields) {
    const value = data[field];
    if (value === undefined || value === null || value === '' ||
        (Array.isArray(value) && value.length === 0)) {
      missing.push(field);
    }
  }

  return {
    valid: missing.length === 0,
    missing
  };
}

/**
 * Truncate text to a maximum length while preserving word boundaries.
 *
 * @param text - Text to truncate
 * @param maxLength - Maximum length
 * @returns Truncated text with ellipsis if needed
 */
export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;

  const truncated = text.slice(0, maxLength);
  const lastSpace = truncated.lastIndexOf(' ');

  if (lastSpace > maxLength * 0.8) {
    return truncated.slice(0, lastSpace) + '...';
  }

  return truncated + '...';
}
