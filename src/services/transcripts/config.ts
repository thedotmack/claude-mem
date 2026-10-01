import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
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
  const raw = readFileSync(resolvedPath, 'utf-8');
  const parsed = JSON.parse(raw) as TranscriptWatchConfig;
  if (!parsed.version || !parsed.watches) {
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
