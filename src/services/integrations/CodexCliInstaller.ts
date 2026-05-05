
import path from 'path';
import { homedir } from 'os';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { logger } from '../../utils/logger.js';
import { replaceTaggedContent } from '../../utils/claude-md-utils.js';
import {
  DEFAULT_CONFIG_PATH,
  DEFAULT_STATE_PATH,
  SAMPLE_CONFIG,
} from '../transcripts/config.js';
import { paths } from '../../shared/paths.js';
import type { TranscriptWatchConfig, WatchTarget } from '../transcripts/types.js';

const CODEX_DIR = path.join(homedir(), '.codex');
const CODEX_AGENTS_MD_PATH = path.join(CODEX_DIR, 'AGENTS.md');
const CLAUDE_MEM_DIR = paths.dataDir();

const CODEX_WATCH_NAME = 'codex';

function loadExistingTranscriptWatchConfig(): TranscriptWatchConfig {
  const configPath = DEFAULT_CONFIG_PATH;

  if (!existsSync(configPath)) {
    return { version: 1, schemas: {}, watches: [], stateFile: DEFAULT_STATE_PATH };
  }

  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as TranscriptWatchConfig;

    if (!parsed.version) parsed.version = 1;
    if (!parsed.watches) parsed.watches = [];
    if (!parsed.schemas) parsed.schemas = {};
    if (!parsed.stateFile) parsed.stateFile = DEFAULT_STATE_PATH;

    return parsed;
  } catch (parseError) {
    if (parseError instanceof Error) {
      logger.error('WORKER', 'Corrupt transcript-watch.json, creating backup', { path: configPath }, parseError);
    } else {
      logger.error('WORKER', 'Corrupt transcript-watch.json, creating backup', { path: configPath }, new Error(String(parseError)));
    }

    const backupPath = `${configPath}.backup.${Date.now()}`;
    writeFileSync(backupPath, readFileSync(configPath));
    console.warn(`  Backed up corrupt transcript-watch.json to ${backupPath}`);

    return { version: 1, schemas: {}, watches: [], stateFile: DEFAULT_STATE_PATH };
  }
}

function mergeCodexWatchConfig(existingConfig: TranscriptWatchConfig): TranscriptWatchConfig {
  const merged = { ...existingConfig };

  merged.schemas = { ...merged.schemas };
  const codexSchema = SAMPLE_CONFIG.schemas?.[CODEX_WATCH_NAME];
  if (codexSchema) {
    merged.schemas[CODEX_WATCH_NAME] = codexSchema;
  }

  const codexWatchFromSample = SAMPLE_CONFIG.watches.find(
    (w: WatchTarget) => w.name === CODEX_WATCH_NAME,
  );

  if (codexWatchFromSample) {
    const existingWatchIndex = merged.watches.findIndex(
      (w: WatchTarget) => w.name === CODEX_WATCH_NAME,
    );

    if (existingWatchIndex !== -1) {
      merged.watches[existingWatchIndex] = codexWatchFromSample;
    } else {
      merged.watches.push(codexWatchFromSample);
    }
  }

  return merged;
}

function writeTranscriptWatchConfig(config: TranscriptWatchConfig): void {
  mkdirSync(CLAUDE_MEM_DIR, { recursive: true });
  writeFileSync(DEFAULT_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

function removeCodexAgentsMdContext(): void {
  if (!existsSync(CODEX_AGENTS_MD_PATH)) return;

  const startTag = '<claude-mem-context>';
  const endTag = '</claude-mem-context>';

  try {
    readAndStripContextTags(startTag, endTag);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('WORKER', 'Failed to clean AGENTS.md context', { error: message });
  }
}

function readAndStripContextTags(startTag: string, endTag: string): void {
  const content = readFileSync(CODEX_AGENTS_MD_PATH, 'utf-8');

  const startIdx = content.indexOf(startTag);
  const endIdx = content.indexOf(endTag);

  if (startIdx === -1 || endIdx === -1) return;

  const before = content.substring(0, startIdx).replace(/\n+$/, '');
  const after = content.substring(endIdx + endTag.length).replace(/^\n+/, '');
  const finalContent = (before + (after ? '\n\n' + after : '')).trim();

  if (finalContent) {
    writeFileSync(CODEX_AGENTS_MD_PATH, finalContent + '\n');
  } else {
    writeFileSync(CODEX_AGENTS_MD_PATH, '');
  }

  console.log(`  Removed legacy global context from ${CODEX_AGENTS_MD_PATH}`);
}

const cleanupLegacyCodexAgentsMdContext = removeCodexAgentsMdContext;

export async function installCodexCli(): Promise<number> {
  console.log('\nInstalling Claude-Mem for Codex CLI (transcript watching)...\n');

  const existingConfig = loadExistingTranscriptWatchConfig();
  const mergedConfig = mergeCodexWatchConfig(existingConfig);

  try {
    writeConfigAndShowCodexInstructions(mergedConfig);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nInstallation failed: ${message}`);
    return 1;
  }
}

function writeConfigAndShowCodexInstructions(mergedConfig: TranscriptWatchConfig): void {
  writeTranscriptWatchConfig(mergedConfig);
  console.log(`  Updated ${DEFAULT_CONFIG_PATH}`);
  console.log(`  Watch path: ~/.codex/sessions/**/*.jsonl`);
  console.log(`  Schema: codex (v${SAMPLE_CONFIG.schemas?.codex?.version ?? '?'})`);

  cleanupLegacyCodexAgentsMdContext();

  console.log(`
Installation complete!

Transcript watch config: ${DEFAULT_CONFIG_PATH}
Context files: <workspace>/AGENTS.md

How it works:
  - claude-mem watches Codex session JSONL files for new activity
  - No hooks needed -- transcript watching is fully automatic
  - Context from past sessions is injected via AGENTS.md in the active Codex workspace

Next steps:
  1. Start claude-mem worker: npx claude-mem start
  2. Use Codex CLI as usual -- memory capture is automatic!
`);
}

export function uninstallCodexCli(): number {
  console.log('\nUninstalling Claude-Mem Codex CLI integration...\n');

  if (existsSync(DEFAULT_CONFIG_PATH)) {
    const config = loadExistingTranscriptWatchConfig();

    config.watches = config.watches.filter(
      (w: WatchTarget) => w.name !== CODEX_WATCH_NAME,
    );

    if (config.schemas) {
      delete config.schemas[CODEX_WATCH_NAME];
    }

    try {
      writeTranscriptWatchConfig(config);
      console.log(`  Removed codex watch from ${DEFAULT_CONFIG_PATH}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`\nUninstallation failed: ${message}`);
      return 1;
    }
  } else {
    console.log('  No transcript-watch.json found -- nothing to remove.');
  }

  cleanupLegacyCodexAgentsMdContext();

  console.log('\nUninstallation complete!');
  console.log('Restart claude-mem worker to apply changes.\n');

  return 0;
}

