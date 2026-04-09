/**
 * Knowledge Agent types
 *
 * Defines the corpus data model for building and querying knowledge agent context.
 */

export interface CorpusFilter {
  project?: string;
  types?: Array<'decision' | 'bugfix' | 'feature' | 'refactor' | 'discovery' | 'change'>;
  concepts?: string[];
  files?: string[];
  query?: string;
  date_start?: string;  // ISO date
  date_end?: string;    // ISO date
  limit?: number;
}

export interface CorpusStats {
  observation_count: number;
  token_estimate: number;
  date_range: { earliest: string; latest: string };
  type_breakdown: Record<string, number>;
}

export interface CorpusObservation {
  id: number;
  type: string;
  title: string;
  subtitle: string | null;
  narrative: string | null;
  facts: string[];
  concepts: string[];
  files_read: string[];
  files_modified: string[];
  project: string;
  created_at: string;
  created_at_epoch: number;
}

export interface CorpusFile {
  version: 1;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
  filter: CorpusFilter;
  stats: CorpusStats;
  system_prompt: string;
  session_id: string | null;
  observations: CorpusObservation[];
}

export interface QueryResult {
  answer: string;
  session_id: string;
}
