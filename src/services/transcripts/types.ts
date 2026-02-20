export type FieldSpec =
  | string
  | {
      path?: string;
      value?: unknown;
      coalesce?: FieldSpec[];
      default?: unknown;
    };

export interface MatchRule {
  path?: string;
  equals?: unknown;
  in?: unknown[];
  contains?: string;
  exists?: boolean;
  regex?: string;
}

export type EventAction =
  | 'session_init'
  | 'session_context'
  | 'user_message'
  | 'assistant_message'
  | 'tool_use'
  | 'tool_result'
  | 'observation'
  | 'file_edit'
  | 'session_end';

export interface SchemaEvent {
  name: string;
  match?: MatchRule;
  action: EventAction;
  fields?: Record<string, FieldSpec>;
}

export interface TranscriptSchema {
  name: string;
  version?: string;
  description?: string;
  eventTypePath?: string;
  sessionIdPath?: string;
  cwdPath?: string;
  projectPath?: string;
  events: SchemaEvent[];
}

export interface WatchContextConfig {
  mode: 'agents';
  path?: string;
  updateOn?: Array<'session_start' | 'session_end'>;
}

export interface WatchTarget {
  name: string;
  path: string;
  schema: string | TranscriptSchema;
  workspace?: string;
  project?: string;
  context?: WatchContextConfig;
  rescanIntervalMs?: number;
  startAtEnd?: boolean;
}

export interface TranscriptWatchConfig {
  version: 1;
  schemas?: Record<string, TranscriptSchema>;
  watches: WatchTarget[];
  stateFile?: string;
}
