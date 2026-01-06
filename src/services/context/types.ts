/**
 * Context Types - Shared types for context generation module
 */

/**
 * Input parameters for context generation
 */
export interface ContextInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  source?: "startup" | "resume" | "clear" | "compact";
  /** Array of projects to query (for worktree support: [parent, worktree]) */
  projects?: string[];
  [key: string]: any;
}

/**
 * Configuration for context generation
 */
export interface ContextConfig {
  // Display counts
  totalObservationCount: number;
  fullObservationCount: number;
  sessionCount: number;

  // Token display toggles
  showReadTokens: boolean;
  showWorkTokens: boolean;
  showSavingsAmount: boolean;
  showSavingsPercent: boolean;

  // Filters
  observationTypes: Set<string>;
  observationConcepts: Set<string>;

  // Display options
  fullObservationField: 'narrative' | 'facts';
  showLastSummary: boolean;
  showLastMessage: boolean;
}

/**
 * Observation record from database
 */
export interface Observation {
  id: number;
  memory_session_id: string;
  type: string;
  title: string | null;
  subtitle: string | null;
  narrative: string | null;
  facts: string | null;
  concepts: string | null;
  files_read: string | null;
  files_modified: string | null;
  discovery_tokens: number | null;
  created_at: string;
  created_at_epoch: number;
  /** Project this observation belongs to (for multi-project queries) */
  project?: string;
}

/**
 * Session summary record from database
 */
export interface SessionSummary {
  id: number;
  memory_session_id: string;
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  created_at: string;
  created_at_epoch: number;
  /** Project this summary belongs to (for multi-project queries) */
  project?: string;
}

/**
 * Summary with timeline display info
 */
export interface SummaryTimelineItem extends SessionSummary {
  displayEpoch: number;
  displayTime: string;
  shouldShowLink: boolean;
}

/**
 * Timeline item - either observation or summary
 */
export type TimelineItem =
  | { type: 'observation'; data: Observation }
  | { type: 'summary'; data: SummaryTimelineItem };

/**
 * Token economics data
 */
export interface TokenEconomics {
  totalObservations: number;
  totalReadTokens: number;
  totalDiscoveryTokens: number;
  savings: number;
  savingsPercent: number;
}

/**
 * Prior messages from transcript
 */
export interface PriorMessages {
  userMessage: string;
  assistantMessage: string;
}

/**
 * ANSI color codes for terminal output
 */
export const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  gray: '\x1b[90m',
  red: '\x1b[31m',
};

/**
 * Configuration constants
 */
export const CHARS_PER_TOKEN_ESTIMATE = 4;
export const SUMMARY_LOOKAHEAD = 1;
