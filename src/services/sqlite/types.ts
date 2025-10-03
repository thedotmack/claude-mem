/**
 * Database entity types for SQLite storage
 */

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
  // Hierarchical memory fields (v2)
  title?: string;
  subtitle?: string;
  facts?: string; // JSON array of fact strings
  concepts?: string; // JSON array of concept strings
  files_touched?: string; // JSON array of file paths
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

/**
 * Input types for creating new records (without id and auto-generated fields)
 */
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
  // Hierarchical memory fields (v2)
  title?: string;
  subtitle?: string;
  facts?: string; // JSON array of fact strings
  concepts?: string; // JSON array of concept strings
  files_touched?: string; // JSON array of file paths
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

/**
 * Helper function to normalize timestamps from various formats
 */
export function normalizeTimestamp(timestamp: string | Date | number | undefined): { isoString: string; epoch: number } {
  let date: Date;
  
  if (!timestamp) {
    date = new Date();
  } else if (timestamp instanceof Date) {
    date = timestamp;
  } else if (typeof timestamp === 'number') {
    date = new Date(timestamp);
  } else if (typeof timestamp === 'string') {
    // Handle empty strings
    if (!timestamp.trim()) {
      date = new Date();
    } else {
      date = new Date(timestamp);
      // If invalid date, try to parse it differently
      if (isNaN(date.getTime())) {
        // Try common formats
        const cleaned = timestamp.replace(/\s+/g, 'T').replace(/T+/g, 'T');
        date = new Date(cleaned);
        
        // Still invalid? Use current time
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
