/**
 * Folder Index Types
 * Configuration and types for folder discovery and indexing
 */

/**
 * Configuration for folder index generation
 */
export interface FolderIndexConfig {
  /**
   * Whether folder indexing is enabled
   */
  enabled: boolean;

  /**
   * Maximum folder depth to generate CLAUDE.md files
   * Example: 3 = src/services/sqlite but not src/services/sqlite/observations
   */
  maxDepth: number;

  /**
   * Folders to exclude from indexing (e.g., build artifacts, dependencies)
   */
  excludeFolders: string[];

  /**
   * Minimum number of observations that reference files in a folder
   * before generating a CLAUDE.md for that folder
   */
  minActivityThreshold: number;
}

/**
 * Timeline observation entry
 */
export interface TimelineObservation {
  type: string;
  title: string;
  files: string[];
  summary: string;
}

/**
 * Compiled folder timeline content
 */
export interface FolderTimelineContent {
  folderPath: string;
  lastUpdated: string; // ISO timestamp
  observationCount: number;
  timeline: Array<{
    date: string;
    observations: TimelineObservation[];
  }>;
}
