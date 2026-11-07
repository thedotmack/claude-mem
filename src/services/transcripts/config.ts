import { existsSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { readJsonFileWithBom } from '../../shared/atomic-json.js';
import { expandTilde, paths } from '../../shared/paths.js';
import type { EventAction, TranscriptSchema, TranscriptWatchConfig } from './types.js';
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

type JsonObject = Record<string, unknown>;

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Every action the processor handles. Typed, so a new EventAction must be listed here too. */
const EVENT_ACTIONS: Record<EventAction, true> = {
  session_init: true,
  session_context: true,
  user_message: true,
  assistant_message: true,
  tool_use: true,
  tool_result: true,
  observation: true,
  file_edit: true,
  session_end: true,
};

/** Throws "<location> <rule>"; the loader adds the file, so `transcript validate` says what to fix. */
function check(condition: unknown, location: string, rule: string): asserts condition {
  if (!condition) throw new Error(`${location} ${rule}`);
}

function checkOptionalString(value: unknown, location: string): void {
  check(value === undefined || typeof value === 'string', location, 'must be a string');
}

function checkNonEmptyString(value: unknown, location: string): void {
  check(typeof value === 'string' && value.trim().length > 0, location, 'must be a non-empty string');
}

function checkOptionalBoolean(value: unknown, location: string): void {
  check(value === undefined || typeof value === 'boolean', location, 'must be true or false');
}

function checkFieldSpec(value: unknown, location: string): void {
  if (typeof value === 'string') return;
  check(isJsonObject(value), location, 'must be a path string or an object');
  checkOptionalString(value.path, `${location}.path`);
  if (value.coalesce === undefined) return;
  check(Array.isArray(value.coalesce), `${location}.coalesce`, 'must be an array');
  value.coalesce.forEach((spec, index) => checkFieldSpec(spec, `${location}.coalesce[${index}]`));
}

function checkMatchRule(value: unknown, location: string): void {
  check(isJsonObject(value), location, 'must be an object');
  for (const key of ['path', 'regex', 'contains', 'not_contains', 'starts_with', 'not_starts_with']) {
    checkOptionalString(value[key], `${location}.${key}`);
  }
  if (typeof value.regex === 'string') {
    try {
      new RegExp(value.regex);
    } catch {
      check(false, `${location}.regex`, 'must be a valid regular expression');
    }
  }
  checkOptionalBoolean(value.exists, `${location}.exists`);
  for (const key of ['in', 'not_in']) {
    check(value[key] === undefined || Array.isArray(value[key]), `${location}.${key}`, 'must be an array');
  }
  for (const key of ['all', 'any']) {
    const rules = value[key];
    if (rules === undefined) continue;
    check(Array.isArray(rules), `${location}.${key}`, 'must be an array');
    rules.forEach((rule, index) => checkMatchRule(rule, `${location}.${key}[${index}]`));
  }
}

function checkSchema(value: unknown, location: string): void {
  check(isJsonObject(value), location, 'must be an object');
  checkNonEmptyString(value.name, `${location}.name`);
  for (const key of ['eventTypePath', 'sessionIdPath', 'cwdPath', 'projectPath']) {
    checkOptionalString(value[key], `${location}.${key}`);
  }
  check(Array.isArray(value.events), `${location}.events`, 'must be an array');
  value.events.forEach((event, index) => {
    const eventLocation = `${location}.events[${index}]`;
    check(isJsonObject(event), eventLocation, 'must be an object');
    check(typeof event.name === 'string', `${eventLocation}.name`, 'must be a string');
    check(typeof event.action === 'string' && Object.hasOwn(EVENT_ACTIONS, event.action),
      `${eventLocation}.action`, `must be one of ${Object.keys(EVENT_ACTIONS).join(', ')}`);
    if (event.match !== undefined) checkMatchRule(event.match, `${eventLocation}.match`);
    if (event.fields === undefined) return;
    check(isJsonObject(event.fields), `${eventLocation}.fields`, 'must be an object');
    for (const [name, spec] of Object.entries(event.fields)) checkFieldSpec(spec, `${eventLocation}.fields.${name}`);
  });
}

function checkWatch(value: unknown, location: string, schemas: JsonObject | undefined): void {
  check(isJsonObject(value), location, 'must be an object');
  checkNonEmptyString(value.name, `${location}.name`);
  checkNonEmptyString(value.path, `${location}.path`);
  for (const key of ['workspace', 'project', 'agentId']) checkOptionalString(value[key], `${location}.${key}`);
  for (const key of ['startAtEnd', 'subagentOnly']) checkOptionalBoolean(value[key], `${location}.${key}`);
  const { subagentSource, context } = value;
  if (subagentSource !== undefined) {
    check(isJsonObject(subagentSource), `${location}.subagentSource`, 'must be an object');
    check(typeof subagentSource.path === 'string', `${location}.subagentSource.path`, 'must be a string');
  }
  if (context !== undefined) {
    check(isJsonObject(context), `${location}.context`, 'must be an object');
    check(context.mode === 'agents', `${location}.context.mode`, 'must be "agents"');
    checkOptionalString(context.path, `${location}.context.path`);
    if (context.updateOn !== undefined) {
      check(Array.isArray(context.updateOn), `${location}.context.updateOn`, 'must be an array');
      context.updateOn.forEach((trigger, index) => check(trigger === 'session_start' || trigger === 'session_end',
        `${location}.context.updateOn[${index}]`, 'must be "session_start" or "session_end"'));
    }
  }
  if (typeof value.schema !== 'string') {
    check(isJsonObject(value.schema), `${location}.schema`, 'must be a schema name or an inline schema object');
    checkSchema(value.schema, `${location}.schema`);
    return;
  }
  checkNonEmptyString(value.schema, `${location}.schema`);
  // Own entries were checked already; this also rejects a name that resolves
  // through the prototype instead (e.g. "constructor").
  const referenced = schemas?.[value.schema];
  if (referenced !== undefined) checkSchema(referenced, `schemas.${value.schema}`);
}

/**
 * Rejects a document the watcher cannot run, mirroring types.ts. Without it, a
 * non-array `watches` threw inside the watcher, and a non-string match or
 * field path threw on every entry, which the watcher logged and checkpointed
 * past, so those entries were lost without a trace.
 */
function assertTranscriptWatchConfigShape(parsed: unknown): asserts parsed is TranscriptWatchConfig {
  check(isJsonObject(parsed), 'the top level', 'must be an object');
  check(parsed.version === 1, 'version', 'must be 1');
  const { stateFile, schemas, watches } = parsed;
  // null means absent (the default state file), as it did before this check.
  check(stateFile === undefined || stateFile === null || typeof stateFile === 'string', 'stateFile', 'must be a string');
  if (schemas !== undefined) {
    check(isJsonObject(schemas), 'schemas', 'must be an object');
    for (const [name, schema] of Object.entries(schemas)) checkSchema(schema, `schemas.${name}`);
  }
  check(Array.isArray(watches), 'watches', 'must be an array');
  watches.forEach((watch, index) => checkWatch(watch, `watches[${index}]`, schemas));
}

export function loadTranscriptWatchConfig(path = DEFAULT_CONFIG_PATH): TranscriptWatchConfig {
  const resolvedPath = expandHomePath(path);
  if (!existsSync(resolvedPath)) {
    throw new Error(`Transcript watch config not found: ${resolvedPath}`);
  }
  const parsed = readJsonFileWithBom<unknown>(resolvedPath);
  try {
    assertTranscriptWatchConfigShape(parsed);
  } catch (error) {
    const problem = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid transcript watch config: ${resolvedPath} (${problem})`, { cause: error });
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
