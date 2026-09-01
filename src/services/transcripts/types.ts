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
  /**
   * Set when native platform hooks already capture this watch's top-level
   * sessions. The watcher then ingests ONLY sessions it can positively identify
   * as subagent rollouts (see subagentSource), so top-level sessions stay owned
   * by the hooks and nothing is captured twice.
   */
  subagentOnly?: boolean;
  /**
   * How to recognise a subagent session from a transcript entry: read the value
   * at `path` and treat the session as a subagent when it equals `value`. Codex
   * marks subagent rollouts with session_meta.payload.source === 'thread_spawn'.
   */
  subagentSource?: { path: string; value: string };
}

export interface TranscriptWatchConfig {
  version: 1;
  schemas?: Record<string, TranscriptSchema>;
  watches: WatchTarget[];
  stateFile?: string;
}
