/**
 * TypeScript types for Claude Code transcript JSONL structure
 * Based on Python Pydantic models from docs/context/cc-transcript-model-example.py
 */

export interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority: 'high' | 'medium' | 'low';
}

export interface UsageInfo {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
  service_tier?: string;
  server_tool_use?: any;
}

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, any>;
}

export interface ToolResultContent {
  type: 'tool_result';
  tool_use_id: string;
  content: string | Array<Record<string, any>>;
  is_error?: boolean;
}

export interface ThinkingContent {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

export interface ImageSource {
  type: 'base64';
  media_type: string;
  data: string;
}

export interface ImageContent {
  type: 'image';
  source: ImageSource;
}

export type ContentItem =
  | TextContent
  | ToolUseContent
  | ToolResultContent
  | ThinkingContent
  | ImageContent;

export interface UserMessage {
  role: 'user';
  content: string | ContentItem[];
}

export interface AssistantMessage {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: ContentItem[];
  stop_reason?: string;
  stop_sequence?: string;
  usage?: UsageInfo;
}

export interface FileInfo {
  filePath: string;
  content: string;
  numLines: number;
  startLine: number;
  totalLines: number;
}

export interface FileReadResult {
  type: 'text';
  file: FileInfo;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  interrupted: boolean;
  isImage: boolean;
}

export interface TodoResult {
  oldTodos: TodoItem[];
  newTodos: TodoItem[];
}

export interface EditResult {
  oldString?: string;
  newString?: string;
  replaceAll?: boolean;
  originalFile?: string;
  structuredPatch?: any;
  userModified?: boolean;
}

export type ToolUseResult =
  | string
  | TodoItem[]
  | FileReadResult
  | CommandResult
  | TodoResult
  | EditResult
  | ContentItem[];

export interface BaseTranscriptEntry {
  parentUuid?: string;
  isSidechain: boolean;
  userType: string;
  cwd: string;
  sessionId: string;
  version: string;
  uuid: string;
  timestamp: string;
  isMeta?: boolean;
}

export interface UserTranscriptEntry extends BaseTranscriptEntry {
  type: 'user';
  message: UserMessage;
  toolUseResult?: ToolUseResult;
}

export interface AssistantTranscriptEntry extends BaseTranscriptEntry {
  type: 'assistant';
  message: AssistantMessage;
  requestId?: string;
}

export interface SummaryTranscriptEntry {
  type: 'summary';
  summary: string;
  leafUuid: string;
  cwd?: string;
}

export interface SystemTranscriptEntry extends BaseTranscriptEntry {
  type: 'system';
  content: string;
  level?: string; // 'warning', 'info', 'error'
}

export interface QueueOperationTranscriptEntry {
  type: 'queue-operation';
  operation: 'enqueue' | 'dequeue';
  timestamp: string;
  sessionId: string;
  content?: ContentItem[]; // Only present for enqueue operations
}

export type TranscriptEntry =
  | UserTranscriptEntry
  | AssistantTranscriptEntry
  | SummaryTranscriptEntry
  | SystemTranscriptEntry
  | QueueOperationTranscriptEntry;
