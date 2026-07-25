
export interface ObservationRow {
  id: number;
  memory_session_id: string;
  project: string;
  text: string | null;
  type: 'decision' | 'bugfix' | 'feature' | 'refactor' | 'discovery' | 'change';
  title: string | null;
  subtitle: string | null;
  facts: string | null; 
  narrative: string | null;
  concepts: string | null; 
  files_read: string | null; 
  files_modified: string | null; 
  prompt_number: number | null;
  discovery_tokens: number; 
  created_at: string;
  created_at_epoch: number;
}

export interface SessionSummaryRow {
  id: number;
  memory_session_id: string;
  project: string;
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  files_read: string | null; 
  files_edited: string | null; 
  notes: string | null;
  prompt_number: number | null;
  discovery_tokens: number; 
  created_at: string;
  created_at_epoch: number;
}

export interface UserPromptRow {
  id: number;
  session_db_id?: number | null;
  content_session_id: string;
  prompt_number: number;
  prompt_text: string;
  created_at: string;
  created_at_epoch: number;
}

export interface DateRange {
  start?: string | number; 
  end?: string | number;   
}

export interface SearchFilters {
  project?: string;
  platformSource?: string;
  type?: ObservationRow['type'] | ObservationRow['type'][];
  concepts?: string | string[];
  files?: string | string[];
  dateRange?: DateRange;
}

export interface SearchOptions extends SearchFilters {
  limit?: number;
  offset?: number;
  orderBy?: 'relevance' | 'date_desc' | 'date_asc';
  isFolder?: boolean;
}

export interface ObservationSearchResult extends ObservationRow {
  rank?: number; 
  score?: number; 
}

export interface SessionSummarySearchResult extends SessionSummaryRow {
  rank?: number; 
  score?: number; 
}

export interface UserPromptSearchResult extends UserPromptRow {
  rank?: number; 
  score?: number; 
}
