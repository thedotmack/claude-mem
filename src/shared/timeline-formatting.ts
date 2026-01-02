/**
 * Shared timeline formatting utilities
 *
 * Pure formatting and grouping functions extracted from context-generator.ts
 * to be reused by SearchManager and other services.
 */

import path from 'path';

/**
 * Parse JSON array string, returning empty array on failure
 */
export function parseJsonArray(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    // [APPROVED OVERRIDE]: Expected JSON parse failures for malformed data fields, too frequent to log
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
 * Extract first file from files_modified JSON array, or return 'General'
 */
export function extractFirstFile(filesModified: string | null, cwd: string): string {
  const files = parseJsonArray(filesModified);
  return files.length > 0 ? toRelativePath(files[0], cwd) : 'General';
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
