import { existsSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { readJsonFileWithBom } from '../../shared/atomic-json.js';
import { expandTilde, paths } from '../../shared/paths.js';
import type { TranscriptSchema, TranscriptWatchConfig } from './types.js';
import type { SettingsDefaults } from '../../shared/SettingsDefaultsManager.js';

export const DEFAULT_CONFIG_PATH = paths.transcriptsConfig();
export const DEFAULT_STATE_PATH = paths.transcriptsState();

export const SAMPLE_CONFIG: TranscriptWatchConfig = {
  version: 1,
  schemas: {},
  watches: [],
  stateFile: DEFAULT_STATE_PATH
};

export function isNativeHookBackedCodexWatch(watch: { name?: string; path?: string; schema?: string | TranscriptSchema }): boolean {
  const schemaName = typeof watch.schema === 'string' ? watch.schema : watch.schema?.name;
  const nameOrSchemaIsCodex = watch.name === 'codex' || schemaName === 'codex';
  if (!nameOrSchemaIsCodex || !watch.path) return false;

  const normalizedPath = expandHomePath(watch.path).replace(/\\/g, '/');
  const codexSessionsRoot = join(homedir(), '.codex', 'sessions').replace(/\\/g, '/');
  return normalizedPath === `${codexSessionsRoot}/**/*.jsonl`;
}

export function shouldSuppressNativeCodexAgentsContext(watch: {
  name?: string;
  path?: string;
  schema?: string | TranscriptSchema;
  context?: { mode?: string };
}): boolean {
  const schemaName = typeof watch.schema === 'string' ? watch.schema : watch.schema?.name;
  const isCanonicalCodexWatch = watch.name === 'codex' && (!schemaName || schemaName === 'codex');
  return watch.context?.mode === 'agents' && isCanonicalCodexWatch && isNativeHookBackedCodexWatch(watch);
}

/**
 * Where Codex marks a subagent rollout: its first (session_meta) line carries
 * payload.source = {"subagent":{"thread_spawn":{"parent_thread_id":…}}}
 * (Codex 0.147+, #3651). Top-level sessions carry a plain string source
 * ("cli", "vscode") and are captured by the native hooks.
 */
export const CODEX_SUBAGENT_SOURCE = { path: 'payload.source.subagent.thread_spawn' } as const;

export type CodexWatchSettings = Pick<
  SettingsDefaults,
  'CLAUDE_MEM_CODEX_TRANSCRIPT_INGESTION' | 'CLAUDE_MEM_CODEX_SUBAGENT_INGESTION' | 'CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS'
>;

/**
 * Native Codex hooks capture top-level sessions, so the native-hook-backed
 * codex transcript watch is removed by default: nothing is captured twice.
 *
 * The hooks never fire for the subagent threads Codex spawns. Capturing those
 * from their rollouts is opt-in (CLAUDE_MEM_CODEX_SUBAGENT_INGESTION): every
 * tool call of every subagent turn is an observer request, spend that did not
 * exist before #3655 and that lands on the gateway allowance or the user's own
 * plan. Opted in, the watch stays on, scoped to subagent rollouts only, unless
 * subagent observations are switched off altogether
 * (CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS, #2736). With the explicit
 * full-ingestion opt-in the watch is left untouched and ingests every session.
 */
export function scopeNativeHookBackedCodexWatches(
  config: TranscriptWatchConfig,
  settings: CodexWatchSettings,
): { config: TranscriptWatchConfig; scoped: number; removed: number } {
  if (settings.CLAUDE_MEM_CODEX_TRANSCRIPT_INGESTION === 'true') {
    return { config, scoped: 0, removed: 0 };
  }
  const captureSubagents = settings.CLAUDE_MEM_CODEX_SUBAGENT_INGESTION === 'true'
    && settings.CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS !== 'true';

  let scoped = 0;
  let removed = 0;
  const watches: TranscriptWatchConfig['watches'] = [];
  for (const watch of config.watches) {
    if (!isNativeHookBackedCodexWatch(watch)) {
      watches.push(watch);
    } else if (captureSubagents) {
      scoped += 1;
      watches.push({ ...watch, subagentOnly: true, subagentSource: { ...CODEX_SUBAGENT_SOURCE } });
    } else {
      removed += 1;
    }
  }

  return {
    config: {
      ...config,
      watches,
    },
    scoped,
    removed,
  };
}

export function expandHomePath(inputPath: string): string {
  if (!inputPath) return inputPath;
  // Shared expandTilde/expandHome leave `~user/...` alone (resolving another
  // user's home is out of scope). The old inline version sliced one character
  // off any leading tilde, so `~alice/transcripts` was rewritten to
  // `<home>/alice/transcripts` and the watcher ingested nothing silently.
  return expandTilde(inputPath);
}

export function loadTranscriptWatchConfig(path = DEFAULT_CONFIG_PATH): TranscriptWatchConfig {
  const resolvedPath = expandHomePath(path);
  if (!existsSync(resolvedPath)) {
    throw new Error(`Transcript watch config not found: ${resolvedPath}`);
  }
  const parsed = readJsonFileWithBom<TranscriptWatchConfig>(resolvedPath);
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  const optionalText = (value: unknown): boolean => value === undefined || typeof value === 'string';
  const validField = (value: unknown): boolean => {
    if (typeof value === 'string') return true;
    return isRecord(value) && optionalText(value.path)
      && (value.coalesce === undefined || Array.isArray(value.coalesce) && value.coalesce.every(validField));
  };
  const validMatch = (value: unknown): boolean => {
    if (!isRecord(value)) return false;
    return ['path', 'regex', 'contains', 'not_contains', 'starts_with', 'not_starts_with'].every(key => optionalText(value[key]))
      && (value.exists === undefined || typeof value.exists === 'boolean')
      && ['in', 'not_in'].every(key => value[key] === undefined || Array.isArray(value[key]))
      && ['all', 'any'].every(key => value[key] === undefined
        || Array.isArray(value[key]) && value[key].every(validMatch));
  };
  const actions = new Set(['session_init', 'session_context', 'user_message', 'assistant_message',
    'tool_use', 'tool_result', 'observation', 'file_edit', 'session_end']);
  const validSchema = (schema: unknown): schema is TranscriptSchema => {
    if (!isRecord(schema)) return false;
    return typeof schema.name === 'string' && schema.name.trim().length > 0
      && ['eventTypePath', 'sessionIdPath', 'cwdPath', 'projectPath'].every(key => optionalText(schema[key]))
      && Array.isArray(schema.events) && schema.events.every(event => isRecord(event)
        && typeof event.name === 'string' && typeof event.action === 'string' && actions.has(event.action)
        && (event.match === undefined || validMatch(event.match))
        && (event.fields === undefined || isRecord(event.fields) && Object.values(event.fields).every(validField)));
  };
  const validSchemas = parsed?.schemas === undefined
    || isRecord(parsed.schemas) && Object.values(parsed.schemas).every(validSchema);
  const validWatches = Array.isArray(parsed?.watches) && parsed.watches.every(watch =>
    isRecord(watch)
      && typeof watch.name === 'string' && watch.name.trim().length > 0
      && typeof watch.path === 'string' && watch.path.trim().length > 0
      && ['workspace', 'project', 'agentId'].every(key => optionalText(watch[key]))
      && ['startAtEnd', 'subagentOnly'].every(key => watch[key] === undefined || typeof watch[key] === 'boolean')
      && (watch.subagentSource === undefined || isRecord(watch.subagentSource)
        && typeof watch.subagentSource.path === 'string')
      && (watch.context === undefined || isRecord(watch.context) && watch.context.mode === 'agents'
        && optionalText(watch.context.path) && (watch.context.updateOn === undefined
          || Array.isArray(watch.context.updateOn)
            && watch.context.updateOn.every(value => value === 'session_start' || value === 'session_end')))
      && (typeof watch.schema === 'string'
        ? watch.schema.trim().length > 0 && validSchemas
          && (parsed.schemas?.[watch.schema] === undefined || validSchema(parsed.schemas[watch.schema]))
        : validSchema(watch.schema))
  );
  if (parsed?.version !== 1 || !optionalText(parsed.stateFile) || !validSchemas || !validWatches) {
    throw new Error(`Invalid transcript watch config: ${resolvedPath}`);
  }
  if (!parsed.stateFile) {
    parsed.stateFile = DEFAULT_STATE_PATH;
  }
  return parsed;
}

export function writeSampleConfig(path = DEFAULT_CONFIG_PATH): void {
  const resolvedPath = expandHomePath(path);
  const dir = dirname(resolvedPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(resolvedPath, JSON.stringify(SAMPLE_CONFIG, null, 2));
}
