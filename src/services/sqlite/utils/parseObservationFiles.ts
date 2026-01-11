/**
 * Utility for parsing JSON string fields (files_read, files_modified) from database records.
 *
 * These fields are stored as JSON strings in SQLite (e.g., '["src/foo.ts"]') but consumers
 * often need them as arrays. This utility provides consistent, safe parsing.
 *
 * Bug fix for: https://github.com/thedotmack/claude-mem/issues/635
 */

/**
 * Safely parse a JSON array string, returning empty array on failure.
 */
function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Parse files_read and files_modified from a single observation record.
 * Converts JSON strings to arrays.
 */
export function parseObservationFiles<T extends {
  files_read?: string | null;
  files_modified?: string | null;
}>(obs: T): T & { files_read: string[]; files_modified: string[] } {
  return {
    ...obs,
    files_read: parseJsonArray(obs.files_read),
    files_modified: parseJsonArray(obs.files_modified)
  };
}

/**
 * Parse files_read and files_modified from an array of observation records.
 * Batch version for query results.
 */
export function parseObservationsFiles<T extends {
  files_read?: string | null;
  files_modified?: string | null;
}>(observations: T[]): Array<T & { files_read: string[]; files_modified: string[] }> {
  return observations.map(parseObservationFiles);
}

/**
 * Parse files_read and files_edited from a session summary record.
 * Session summaries use 'files_edited' instead of 'files_modified'.
 */
export function parseSummaryFiles<T extends {
  files_read?: string | null;
  files_edited?: string | null;
}>(summary: T): T & { files_read: string[]; files_edited: string[] } {
  return {
    ...summary,
    files_read: parseJsonArray(summary.files_read),
    files_edited: parseJsonArray(summary.files_edited)
  };
}

/**
 * Parse files from an array of session summary records.
 */
export function parseSummariesFiles<T extends {
  files_read?: string | null;
  files_edited?: string | null;
}>(summaries: T[]): Array<T & { files_read: string[]; files_edited: string[] }> {
  return summaries.map(parseSummaryFiles);
}
