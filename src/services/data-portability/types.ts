/**
 * Types for claude-mem data export/import (portability between machines)
 */

/** Current export format version */
export const EXPORT_FORMAT_VERSION = 1;

/** Top-level structure of an export file */
export interface ExportData {
  format_version: number;
  claude_mem_version: string;
  exported_at: string;
  source_machine: string;
  counts: ExportCounts;
  data: ExportTables;
}

/** Record counts per table */
export interface ExportCounts {
  sdk_sessions: number;
  observations: number;
  session_summaries: number;
  user_prompts: number;
}

/** All exported table data */
export interface ExportTables {
  sdk_sessions: ExportSdkSession[];
  observations: ExportObservation[];
  session_summaries: ExportSessionSummary[];
  user_prompts: ExportUserPrompt[];
}

/** SDK session record */
export interface ExportSdkSession {
  content_session_id: string;
  memory_session_id: string;
  project: string;
  user_prompt: string;
  started_at: string;
  started_at_epoch: number;
  completed_at: string | null;
  completed_at_epoch: number | null;
  status: string;
}

/** Observation record */
export interface ExportObservation {
  memory_session_id: string;
  project: string;
  text: string | null;
  type: string;
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

/** Session summary record */
export interface ExportSessionSummary {
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

/** User prompt record */
export interface ExportUserPrompt {
  content_session_id: string;
  prompt_number: number;
  prompt_text: string;
  created_at: string;
  created_at_epoch: number;
}

/** Per-table import result */
export interface TableImportResult {
  imported: number;
  skipped: number;
  errors: number;
}

/** Overall import result */
export interface ImportSummary {
  sdk_sessions: TableImportResult;
  observations: TableImportResult;
  session_summaries: TableImportResult;
  user_prompts: TableImportResult;
  total_imported: number;
  total_skipped: number;
}
