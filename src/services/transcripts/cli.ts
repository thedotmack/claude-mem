import { DEFAULT_CONFIG_PATH, DEFAULT_STATE_PATH, expandHomePath, loadTranscriptWatchConfig, writeSampleConfig } from './config.js';
import { TranscriptWatcher } from './watcher.js';
import { dryRunSource, formatDryRunReport } from './ingest.js';

function getArgValue(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] ?? null;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
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
    case 'ingest': {
      const source = getArgValue(args, '--source');
      if (!source) {
        console.error('Usage: claude-mem transcript ingest --source <dir|file> [--dry-run] [--include-subagents]');
        return 1;
      }
      const includeSubagents = hasFlag(args, '--include-subagents');

      if (hasFlag(args, '--dry-run')) {
        const report = dryRunSource(source, { includeSubagents });
        console.log(formatDryRunReport(report));
        return 0;
      }

      // Real ingest calls ingestObservation, which requires the worker's
      // setIngestContext — it must run inside the worker over HTTP, not here.
      // That path lands in the follow-up PR. Until then, fail loudly rather
      // than spend Haiku from a context that cannot honor idempotency.
      console.error(
        'Real ingest (worker-driven) is not wired yet. Run with --dry-run for the cost preview.'
      );
      return 2;
    }
    default:
      console.log('Usage: claude-mem transcript <init|watch|validate|ingest> [--config <path>]');
      return 1;
  }
}
