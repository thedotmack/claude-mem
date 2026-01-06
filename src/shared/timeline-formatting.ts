/**
 * Shared timeline formatting utilities
 *
 * Pure formatting and grouping functions extracted from context-generator.ts
 * to be reused by SearchManager and other services.
 */

import path from 'path';
import { logger } from '../utils/logger.js';

/**
 * Parse JSON array string, returning empty array on failure
 */
export function parseJsonArray(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    logger.debug('PARSER', 'Failed to parse JSON array, using empty fallback', {
      preview: json?.substring(0, 50)
    }, err as Error);
    return [];
  }
}

/**
 * Format date with time (e.g., "Dec 14, 7:30 PM")
 * Accepts either ISO date string or epoch milliseconds
 */
export function formatDateTime(dateInput: string | number): string {
  const date = new Date(dateInput);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
}

/**
 * Format just time, no date (e.g., "7:30 PM")
 * Accepts either ISO date string or epoch milliseconds
 */
export function formatTime(dateInput: string | number): string {
  const date = new Date(dateInput);
  return date.toLocaleString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
}

/**
 * Format just date (e.g., "Dec 14, 2025")
 * Accepts either ISO date string or epoch milliseconds
 */
export function formatDate(dateInput: string | number): string {
  const date = new Date(dateInput);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
}

/**
 * Convert absolute paths to relative paths
 */
export function toRelativePath(filePath: string, cwd: string): string {
  if (path.isAbsolute(filePath)) {
    return path.relative(cwd, filePath);
  }
  return filePath;
}

/**
 * Extract first relevant file from files_modified OR files_read JSON arrays.
 * Prefers files_modified, falls back to files_read.
 * Returns 'General' only if both are empty.
 */
export function extractFirstFile(
  filesModified: string | null,
  cwd: string,
  filesRead?: string | null
): string {
  // Try files_modified first
  const modified = parseJsonArray(filesModified);
  if (modified.length > 0) {
    return toRelativePath(modified[0], cwd);
  }

  // Fall back to files_read
  if (filesRead) {
    const read = parseJsonArray(filesRead);
    if (read.length > 0) {
      return toRelativePath(read[0], cwd);
    }
  }

  return 'General';
}

/**
 * Estimate token count for text (rough approximation: ~4 chars per token)
 */
export function estimateTokens(text: string | null): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Group items by date
 *
 * Generic function that works with any item type that has a date field.
 * Returns a Map of date string -> items array, sorted chronologically.
 *
 * @param items - Array of items to group
 * @param getDate - Function to extract date string from each item
 * @returns Map of formatted date strings to item arrays, sorted chronologically
 */
export function groupByDate<T>(
  items: T[],
  getDate: (item: T) => string
): Map<string, T[]> {
  // Group by day
  const itemsByDay = new Map<string, T[]>();
  for (const item of items) {
    const itemDate = getDate(item);
    const day = formatDate(itemDate);
    if (!itemsByDay.has(day)) {
      itemsByDay.set(day, []);
    }
    itemsByDay.get(day)!.push(item);
  }

  // Sort days chronologically
  const sortedEntries = Array.from(itemsByDay.entries()).sort((a, b) => {
    const aDate = new Date(a[0]).getTime();
    const bDate = new Date(b[0]).getTime();
    return aDate - bDate;
  });

  return new Map(sortedEntries);
}
