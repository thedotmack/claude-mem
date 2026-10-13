
export interface ContextInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  source?: "startup" | "resume" | "clear" | "compact";
  projects?: string[];
  platformSource?: string;
  full?: boolean;
  /**
   * Set false to build the context without the observer-health outage banner.
   *
   * The banner is written for the primary assistant and ends with an
   * instruction addressed to it. Builds that are consumed by the observer
   * itself must opt out (#4221).
   */
  includeHealthWarning?: boolean;
  /**
   * False renders without the prior session's reply whatever the setting says:
   * for a block that may be cached, which any session can read.
   */
  includePriorMessage?: boolean;
  /**
   * Characters delivered beside this block (the work-state section), taken off
   * the 10K delivery limit so the combined output still fits it.
   */
  reserveChars?: number;
  /**
   * Render the header time as a placeholder that `fillContextPlaceholders`
   * fills at read time, so the block can be cached (shared/context-cache.ts).
   * The fitter's limit shrinks by what the placeholder can grow by.
   */
  timePlaceholders?: boolean;
  [key: string]: any;
}

export interface ContextConfig {
  totalObservationCount: number;
  fullObservationCount: number;
  sessionCount: number;

  showReadTokens: boolean;
  showWorkTokens: boolean;
  showSavingsAmount: boolean;
  showSavingsPercent: boolean;

  observationTypes: Set<string>;
  observationConcepts: Set<string>;

  fullObservationField: 'narrative' | 'facts';
  showLastSummary: boolean;
  showLastMessage: boolean;
  mainAgentOnly: boolean;
  /**
   * ACT-R reinforcement weight for observation selection
   * (CLAUDE_MEM_REINFORCE_ALPHA). Absent or 0 = off: the N most recent.
   */
  reinforcementAlpha?: number;

  /**
   * Whether observation refs in the inject panel can be fetched by id.
   * When false (server runtime, where ids are Postgres UUIDs), refs are
   * abbreviated to an 8-char prefix (display-only) and the legend points to
   * observation_search. Defaults to true (full id shown) when omitted.
   */
  fetchByIdSupported?: boolean;
}

export interface Observation {
  // A numeric SQLite id, or the server's string id in server runtime.
  id: number | string;
  memory_session_id: string;
  /** Observed host session identity, used to resolve its transcript. */
  content_session_id?: string | null;
  platform_source?: string;
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
  project?: string;
  /** Selected only while reinforcement ranking is on. */
  reinforcement_dates?: string | null;
}

export interface SessionSummary {
  // A numeric SQLite id, or the server's string id in server runtime.
  id: number | string;
  memory_session_id: string;
  platform_source?: string;
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  notes?: string | null;
  created_at: string;
  created_at_epoch: number;
  project?: string;
}

/** Rows read from the local SQLite database always carry numeric ids. */
export type LocalObservation = Observation & { id: number };
export type LocalSessionSummary = SessionSummary & { id: number };

export interface SummaryTimelineItem extends SessionSummary {
  displayEpoch: number;
  displayTime: string;
  shouldShowLink: boolean;
}

export type TimelineItem =
  | { type: 'observation'; data: Observation }
  | { type: 'summary'; data: SummaryTimelineItem };

export interface TokenEconomics {
  totalObservations: number;
  totalReadTokens: number;
  totalDiscoveryTokens: number;
  savings: number;
  savingsPercent: number;
}

export interface PriorMessages {
  assistantMessage: string;
}

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

export const CHARS_PER_TOKEN_ESTIMATE = 4;
export const SUMMARY_LOOKAHEAD = 1;
