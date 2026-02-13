/**
 * Type definitions for thought storage operations
 * Represents thinking blocks extracted from Claude Code transcripts
 */

/**
 * Input type for storing a thought (thinking block)
 */
export interface ThoughtInput {
  thinking_text: string;
  thinking_summary: string | null;
  message_index: number | null;
}

/**
 * Full thought record as stored in the database
 */
export interface Thought extends ThoughtInput {
  id: number;
  memory_session_id: string;
  content_session_id: string | null;
  project: string;
  prompt_number: number | null;
  created_at: string;
  created_at_epoch: number;
}
