import path from 'path';
import { homedir } from 'os';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { logger } from '../../utils/logger.js';
import { findBunPath, findWorkerServicePath } from './CursorHooksInstaller.js';
import {
  DEFAULT_CONFIG_PATH as TRANSCRIPT_CONFIG_PATH,
  DEFAULT_STATE_PATH as TRANSCRIPT_STATE_PATH,
  SAMPLE_CONFIG as TRANSCRIPT_SAMPLE_CONFIG,
} from '../transcripts/config.js';
import type { TranscriptWatchConfig, WatchTarget } from '../transcripts/types.js';

const CRUSH_CONFIG_DIR = path.join(homedir(), '.config', 'crush');
const CRUSH_CONFIG_PATH = path.join(CRUSH_CONFIG_DIR, 'crush.json');

const CLAUDE_MEM_HOOK_MARKER = 'claude-mem-hook';

interface CrushHookEntry {
  matcher?: string;
  command: string;
  timeout?: number;
}

interface CrushHooksConfig {
  hooks?: {
    PreToolUse?: CrushHookEntry[];
    [event: string]: CrushHookEntry[] | undefined;
  };
  [key: string]: unknown;
}

const FILE_EDIT_MATCHER = '^(write|edit|multiedit)$';
const OBSERVATION_MATCHER = '^(?!write$|edit$|multiedit$).*';

function buildFileEditCommand(bunPath: string, workerServicePath: string): string {
  return `"${bunPath}" "${workerServicePath}" hook crush file-edit # ${CLAUDE_MEM_HOOK_MARKER}`;
}

function buildObservationCommand(bunPath: string, workerServicePath: string): string {
  return `"${bunPath}" "${workerServicePath}" hook crush observation # ${CLAUDE_MEM_HOOK_MARKER}`;
}

function readCrushConfig(): CrushHooksConfig {
  if (!existsSync(CRUSH_CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CRUSH_CONFIG_PATH, 'utf-8'));
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    logger.error(
      'CRUSH',
      'Corrupt crush.json, refusing to overwrite',
      { path: CRUSH_CONFIG_PATH },
      normalized,
    );
    throw new Error(
      `Corrupt crush.json at ${CRUSH_CONFIG_PATH}, refusing to overwrite. Fix the file and rerun.`,
    );
  }
}

function stripClaudeMemEntries(entries: CrushHookEntry[] | undefined): CrushHookEntry[] {
  if (!Array.isArray(entries)) return [];
  return entries.filter((entry) => !(entry?.command ?? '').includes(CLAUDE_MEM_HOOK_MARKER));
}

function mergeCrushHooks(bunPath: string, workerServicePath: string): void {
  mkdirSync(CRUSH_CONFIG_DIR, { recursive: true });

  const config = readCrushConfig();
  if (!config.hooks || typeof config.hooks !== 'object') {
    config.hooks = {};
  }

  const existing = stripClaudeMemEntries(config.hooks.PreToolUse);

  const fileEditEntry: CrushHookEntry = {
    matcher: FILE_EDIT_MATCHER,
    command: buildFileEditCommand(bunPath, workerServicePath),
    timeout: 15,
  };

  const observationEntry: CrushHookEntry = {
    matcher: OBSERVATION_MATCHER,
    command: buildObservationCommand(bunPath, workerServicePath),
    timeout: 15,
  };

  config.hooks.PreToolUse = [...existing, fileEditEntry, observationEntry];

  writeFileSync(CRUSH_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

export async function installCrushHooks(): Promise<number> {
  console.log('\nInstalling Claude-Mem Crush hooks (user level)...\n');

  const workerServicePath = findWorkerServicePath();
  if (!workerServicePath) {
    console.error('Could not find worker-service.cjs');
    console.error('   Expected at: ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs');
    return 1;
  }

  const bunPath = findBunPath();
  if (!bunPath) {
    console.error('Could not find Bun runtime');
    console.error('   Install Bun: curl -fsSL https://bun.sh/install | bash');
    return 1;
  }

  console.log(`  Using Bun runtime: ${bunPath}`);
  console.log(`  Worker service:   ${workerServicePath}`);

  try {
    mergeCrushHooks(bunPath, workerServicePath);
    console.log(`  Wrote PreToolUse hooks to: ${CRUSH_CONFIG_PATH}`);
    console.log(`
Installation complete!

Events registered (PreToolUse only — the only lifecycle hook Crush supports):
  - write|edit|multiedit  → file-edit observation
  - (all other tools)     → generic observation

Next steps:
  1. Ensure the claude-mem worker is running: npx claude-mem start
  2. Restart Crush (or start a new session) to pick up the hooks
  3. Tool observations will stream to the worker at localhost:<worker-port>
`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nInstallation failed: ${message}`);
    return 1;
  }
}

export function uninstallCrushHooks(): number {
  console.log('\nUninstalling Claude-Mem Crush hooks...\n');

  if (!existsSync(CRUSH_CONFIG_PATH)) {
    console.log(`  No crush.json found at ${CRUSH_CONFIG_PATH}`);
    return 0;
  }

  try {
    const config = readCrushConfig();
    if (!config.hooks || typeof config.hooks !== 'object') {
      console.log(`  No hooks section present — nothing to do`);
      return 0;
    }

    const remaining = stripClaudeMemEntries(config.hooks.PreToolUse);
    if (remaining.length === 0) {
      delete config.hooks.PreToolUse;
    } else {
      config.hooks.PreToolUse = remaining;
    }

    if (config.hooks && Object.keys(config.hooks).length === 0) {
      delete config.hooks;
    }

    writeFileSync(CRUSH_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
    console.log(`  Removed claude-mem entries from ${CRUSH_CONFIG_PATH}`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nUninstallation failed: ${message}`);
    return 1;
  }
}

export function checkCrushHooksStatus(): number {
  console.log('\nClaude-Mem Crush Hooks Status\n');

  if (!existsSync(CRUSH_CONFIG_PATH)) {
    console.log('User-level: Not installed');
    console.log(`\nNo hooks installed. Run: npx claude-mem install (and pick Crush)\n`);
    return 0;
  }

  let config: CrushHooksConfig;
  try {
    config = readCrushConfig();
  } catch {
    console.log(`Unable to parse ${CRUSH_CONFIG_PATH}`);
    return 1;
  }

  const entries = config.hooks?.PreToolUse ?? [];
  const claudeMemEntries = entries.filter((entry) =>
    (entry?.command ?? '').includes(CLAUDE_MEM_HOOK_MARKER),
  );

  if (claudeMemEntries.length === 0) {
    console.log('User-level: Not installed');
  } else {
    console.log('User-level: Installed');
    console.log(`   Config:  ${CRUSH_CONFIG_PATH}`);
    console.log(`   Events:  ${claudeMemEntries.length} PreToolUse entries registered`);
    for (const entry of claudeMemEntries) {
      console.log(`     - matcher=${entry.matcher ?? '*'}`);
    }
  }

  console.log('');
  return 0;
}

const CRUSH_TRANSCRIPT_WATCH_NAME = 'crush';
const CLAUDE_MEM_DATA_DIR = path.join(homedir(), '.claude-mem');

function loadExistingTranscriptWatchConfig(): TranscriptWatchConfig {
  if (!existsSync(TRANSCRIPT_CONFIG_PATH)) {
    return {
      version: 1,
      schemas: {},
      watches: [],
      stateFile: TRANSCRIPT_STATE_PATH,
    };
  }

  try {
    const raw = readFileSync(TRANSCRIPT_CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as TranscriptWatchConfig;
    if (!parsed.version) parsed.version = 1;
    if (!parsed.watches) parsed.watches = [];
    if (!parsed.schemas) parsed.schemas = {};
    if (!parsed.stateFile) parsed.stateFile = TRANSCRIPT_STATE_PATH;
    return parsed;
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    logger.error(
      'CRUSH',
      'Corrupt transcript-watch.json, creating backup',
      { path: TRANSCRIPT_CONFIG_PATH },
      normalized,
    );
    const backupPath = `${TRANSCRIPT_CONFIG_PATH}.backup.${Date.now()}`;
    writeFileSync(backupPath, readFileSync(TRANSCRIPT_CONFIG_PATH));
    console.warn(`  Backed up corrupt transcript-watch.json to ${backupPath}`);
    return {
      version: 1,
      schemas: {},
      watches: [],
      stateFile: TRANSCRIPT_STATE_PATH,
    };
  }
}

function mergeCrushTranscriptConfig(existing: TranscriptWatchConfig): TranscriptWatchConfig {
  const merged: TranscriptWatchConfig = {
    ...existing,
    schemas: { ...(existing.schemas ?? {}) },
    watches: Array.isArray(existing.watches) ? [...existing.watches] : [],
  };

  const crushSchema = TRANSCRIPT_SAMPLE_CONFIG.schemas?.[CRUSH_TRANSCRIPT_WATCH_NAME];
  if (crushSchema) {
    merged.schemas![CRUSH_TRANSCRIPT_WATCH_NAME] = crushSchema;
  }

  const sampleWatch = TRANSCRIPT_SAMPLE_CONFIG.watches.find(
    (w: WatchTarget) => w.name === CRUSH_TRANSCRIPT_WATCH_NAME,
  );

  if (sampleWatch) {
    const existingIdx = merged.watches.findIndex(
      (w: WatchTarget) => w.name === CRUSH_TRANSCRIPT_WATCH_NAME,
    );
    if (existingIdx !== -1) {
      merged.watches[existingIdx] = sampleWatch;
    } else {
      merged.watches.push(sampleWatch);
    }
  }

  return merged;
}

function writeTranscriptWatchConfig(config: TranscriptWatchConfig): void {
  mkdirSync(CLAUDE_MEM_DATA_DIR, { recursive: true });
  writeFileSync(TRANSCRIPT_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

export function installCrushTranscript(): number {
  console.log('\nInstalling Claude-Mem Crush transcript watcher...\n');

  try {
    const existing = loadExistingTranscriptWatchConfig();
    const merged = mergeCrushTranscriptConfig(existing);
    writeTranscriptWatchConfig(merged);
    console.log(`  Updated ${TRANSCRIPT_CONFIG_PATH}`);
    console.log(`  Registry: crush-projects (~/.local/share/crush/projects.json)`);
    console.log(`  Schema:   crush (messages.parts via json_each)`);
    console.log(`
Transcript watcher installed.

What it captures (beyond PreToolUse hooks):
  - User prompts        -> session_init + context injection
  - Assistant replies   -> last-message tracking + summary queueing
  - Tool results        -> full observations with tool output
  - Turn completions    -> session_end (queues summary, refreshes context)

The worker polls each project's .crush/crush.db every 2s and
replays new rows from the messages table through the normal
claude-mem event pipeline.

Next steps:
  1. Restart the worker: npx claude-mem restart
  2. Continue using Crush normally -- capture is automatic.
`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nInstallation failed: ${message}`);
    return 1;
  }
}

export function uninstallCrushTranscript(): number {
  console.log('\nUninstalling Claude-Mem Crush transcript watcher...\n');

  if (!existsSync(TRANSCRIPT_CONFIG_PATH)) {
    console.log('  No transcript-watch.json found -- nothing to remove.');
    return 0;
  }

  try {
    const config = loadExistingTranscriptWatchConfig();
    config.watches = config.watches.filter(
      (w: WatchTarget) => w.name !== CRUSH_TRANSCRIPT_WATCH_NAME,
    );
    if (config.schemas) {
      delete config.schemas[CRUSH_TRANSCRIPT_WATCH_NAME];
    }
    writeTranscriptWatchConfig(config);
    console.log(`  Removed crush watch from ${TRANSCRIPT_CONFIG_PATH}`);
    console.log('\nRestart the worker to apply: npx claude-mem restart\n');
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nUninstallation failed: ${message}`);
    return 1;
  }
}
