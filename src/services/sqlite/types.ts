
export interface SessionRow {
  id: number;
  session_id: string;
  project: string;
  created_at: string;
  created_at_epoch: number;
  source: 'compress' | 'save' | 'legacy-jsonl';
  archive_path?: string;
  archive_bytes?: number;
  archive_checksum?: string;
  archived_at?: string;
  metadata_json?: string;
}

export interface OverviewRow {
  id: number;
  session_id: string;
  content: string;
  created_at: string;
  created_at_epoch: number;
  project: string;
  origin: string;
}

export interface MemoryRow {
  id: number;
  session_id: string;
  text: string;
  document_id?: string;
  keywords?: string;
  created_at: string;
  created_at_epoch: number;
  project: string;
  archive_basename?: string;
  origin: string;
  title?: string;
  subtitle?: string;
  facts?: string; 
  concepts?: string; 
  files_touched?: string; 
}

export interface DiagnosticRow {
  id: number;
  session_id?: string;
  message: string;
  severity: 'info' | 'warn' | 'error';
  created_at: string;
  created_at_epoch: number;
  project: string;
  origin: string;
}

export interface TranscriptEventRow {
  id: number;
  session_id: string;
  project?: string;
  event_index: number;
  event_type?: string;
  raw_json: string;
  captured_at: string;
  captured_at_epoch: number;
}

export interface ArchiveRow {
  id: number;
  session_id: string;
  path: string;
  bytes?: number;
  checksum?: string;
  stored_at: string;
  storage_status: 'active' | 'archived' | 'deleted';
}

export interface TitleRow {
  id: number;
  session_id: string;
  title: string;
  created_at: string;
  project: string;
}

export interface SessionInput {
  session_id: string;
  project: string;
  created_at: string;
  source?: 'compress' | 'save' | 'legacy-jsonl';
  archive_path?: string;
  archive_bytes?: number;
  archive_checksum?: string;
  archived_at?: string;
  metadata_json?: string;
}

export interface OverviewInput {
  session_id: string;
  content: string;
  created_at: string;
  project: string;
  origin?: string;
}

export interface MemoryInput {
  session_id: string;
  text: string;
  document_id?: string;
  keywords?: string;
  created_at: string;
  project: string;
  archive_basename?: string;
  origin?: string;
  title?: string;
  subtitle?: string;
  facts?: string; 
  concepts?: string; 
  files_touched?: string; 
}

export interface DiagnosticInput {
  session_id?: string;
  message: string;
  severity?: 'info' | 'warn' | 'error';
  created_at: string;
  project: string;
  origin?: string;
}

export interface TranscriptEventInput {
  session_id: string;
  project?: string;
  event_index: number;
  event_type?: string;
  raw_json: string;
  captured_at?: string | Date | number;
}

export function normalizeTimestamp(timestamp: string | Date | number | undefined): { isoString: string; epoch: number } {
  let date: Date;
  
  if (!timestamp) {
    date = new Date();
  } else if (timestamp instanceof Date) {
    date = timestamp;
  } else if (typeof timestamp === 'number') {
    date = new Date(timestamp);
  } else if (typeof timestamp === 'string') {
    if (!timestamp.trim()) {
      date = new Date();
    } else {
      date = new Date(timestamp);
      if (isNaN(date.getTime())) {
        const cleaned = timestamp.replace(/\s+/g, 'T').replace(/T+/g, 'T');
        date = new Date(cleaned);
        
        if (isNaN(date.getTime())) {
          date = new Date();
        }
      }
    }
  } else {
    date = new Date();
  }
  
  return {
    isoString: date.toISOString(),
    epoch: date.getTime()
  };
}

export interface SDKSessionRow {
  id: number;
  content_session_id: string;
  memory_session_id: string | null;
  project: string;
  user_prompt: string | null;
  started_at: string;
  started_at_epoch: number;
  completed_at: string | null;
  completed_at_epoch: number | null;
  status: 'active' | 'completed' | 'failed';
  worker_port?: number;
  prompt_counter?: number;
}

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
