import { DEFAULT_CONFIG_PATH, DEFAULT_STATE_PATH, expandHomePath, loadTranscriptWatchConfig, writeSampleConfig } from './config.js';
import { TranscriptWatcher } from './watcher.js';

function getArgValue(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] ?? null;
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
      let config;
      try {
        config = loadTranscriptWatchConfig(configPath);
      } catch (error) {
        if (error instanceof Error && error.message.includes('not found')) {
          writeSampleConfig(configPath);
          console.log(`Created sample config: ${expandHomePath(configPath)}`);
          config = loadTranscriptWatchConfig(configPath);
        } else {
          throw error;
        }
      }
      const statePath = expandHomePath(config.stateFile ?? DEFAULT_STATE_PATH);
      const watcher = new TranscriptWatcher(config, statePath);
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
      try {
        loadTranscriptWatchConfig(configPath);
      } catch (error) {
        if (error instanceof Error && error.message.includes('not found')) {
          writeSampleConfig(configPath);
          console.log(`Created sample config: ${expandHomePath(configPath)}`);
          loadTranscriptWatchConfig(configPath);
        } else {
          throw error;
        }
      }
      console.log(`Config OK: ${expandHomePath(configPath)}`);
      return 0;
    }
    default:
      console.log('Usage: claude-mem transcript <init|watch|validate> [--config <path>]');
      return 1;
  }
}
