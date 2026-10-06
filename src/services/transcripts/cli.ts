import { existsSync } from 'fs';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import {
  DEFAULT_CONFIG_PATH,
  DEFAULT_STATE_PATH,
  expandHomePath,
  loadTranscriptWatchConfig,
  scopeNativeHookBackedCodexWatches,
  writeSampleConfig,
} from './config.js';
import { TranscriptWatcher } from './watcher.js';

function getArgValue(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] ?? null;
}

/**
 * Only a missing config gets the sample. This checks the file itself, never
 * the error text: a validation message quotes the config's own keys and path,
 * so matching "not found" in it could overwrite a real config.
 */
function writeSampleConfigIfMissing(configPath: string): void {
  if (existsSync(expandHomePath(configPath))) return;
  writeSampleConfig(configPath);
  console.log(`Created sample config: ${expandHomePath(configPath)}`);
}

export async function runTranscriptCommand(subcommand: string | undefined, args: string[]): Promise<number> {
  switch (subcommand) {
    case 'init': {
      const configPath = getArgValue(args, '--config') ?? DEFAULT_CONFIG_PATH;
      writeSampleConfig(configPath);
      console.log(`Created sample config: ${expandHomePath(configPath)}`);
      return 0;
    }
    case 'watch': {
      const configPath = getArgValue(args, '--config') ?? DEFAULT_CONFIG_PATH;
      writeSampleConfigIfMissing(configPath);
      // The worker's default-off Codex gate applies here too: native hooks
      // capture top-level Codex sessions, and capturing subagent rollouts (an
      // observer request per tool call) is opt-in.
      const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
      const { config, scoped, removed } = scopeNativeHookBackedCodexWatches(loadTranscriptWatchConfig(configPath), settings);
      if (scoped > 0) {
        console.log(`Scoped ${scoped} Codex transcript watch(es) to subagent sessions (CLAUDE_MEM_CODEX_SUBAGENT_INGESTION=true); native hooks capture top-level sessions.`);
      }
      if (removed > 0) {
        console.log(`Skipped ${removed} Codex transcript watch(es): native hooks capture top-level Codex sessions, and subagent capture is opt-in (CLAUDE_MEM_CODEX_SUBAGENT_INGESTION=true).`);
      }
      if (config.watches.length === 0) {
        console.log(`No active transcript watches in ${expandHomePath(configPath)}; nothing to watch.`);
        return 1;
      }
      const statePath = expandHomePath(config.stateFile ?? DEFAULT_STATE_PATH);
      // No in-process worker here: observations and summaries go through the
      // durable hook spool, which the worker drains.
      const watcher = new TranscriptWatcher(config, statePath, 'spool');
      await watcher.start();
      console.log('Transcript watcher running. Press Ctrl+C to stop.');

      const shutdown = () => {
        watcher.stop();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      return await new Promise(() => undefined);
    }
    case 'validate': {
      const configPath = getArgValue(args, '--config') ?? DEFAULT_CONFIG_PATH;
      writeSampleConfigIfMissing(configPath);
      loadTranscriptWatchConfig(configPath);
      console.log(`Config OK: ${expandHomePath(configPath)}`);
      return 0;
    }
    default:
      console.log('Usage: claude-mem transcript <init|watch|validate> [--config <path>]');
      return 1;
  }
}
