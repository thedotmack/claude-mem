export interface QueueMessage {
  id: number;
  session_db_id: number;
  claude_session_id: string;
  message_type: 'observation' | 'summarize';
  tool_name: string | null;
  tool_input: string | null;
  tool_response: string | null;
  cwd: string | null;
  last_user_message: string | null;
  last_assistant_message: string | null;
  prompt_number: number | null;
  created_at_epoch: number;
}

export interface EnqueuePayload {
  type: 'observation' | 'summarize';
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  cwd?: string;
  last_user_message?: string;
  last_assistant_message?: string;
  prompt_number?: number;
}
