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
  not_equals?: unknown;
  in?: unknown[];
  not_in?: unknown[];
  contains?: string;
  not_contains?: string;
  exists?: boolean;
  regex?: string;
  /**
   * Every sub-rule must match. Each sub-rule carries its own `path`, which is
   * the only way to constrain one field by another (e.g. `role == "user"` AND
   * the text is not an injected preamble). Sub-rules may nest.
   */
  all?: MatchRule[];
  /** At least one sub-rule must match. Each sub-rule carries its own `path`. */
  any?: MatchRule[];
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
  startAtEnd?: boolean;
  /** Grok Bot (and similar) host agent id, carried from the watch path into ingest. */
  agentId?: string;
}

export interface TranscriptWatchConfig {
  version: 1;
  schemas?: Record<string, TranscriptSchema>;
  watches: WatchTarget[];
  stateFile?: string;
}
