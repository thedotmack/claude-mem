import { DEFAULT_CONFIG_PATH, DEFAULT_STATE_PATH, expandHomePath, loadTranscriptWatchConfig, writeSampleConfig } from './config.js';
import { TranscriptWatcher } from './watcher.js';

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
    case 'backfill': {
      const { runBackfill } = await import('./backfill.js');

      const options = {
        path: getArgValue(args, '--path') ?? undefined,
        dryRun: hasFlag(args, '--dry-run'),
        limit: getArgValue(args, '--limit') ? parseInt(getArgValue(args, '--limit')!, 10) : undefined,
        delayMs: getArgValue(args, '--delay') ? parseInt(getArgValue(args, '--delay')!, 10) : undefined,
        force: hasFlag(args, '--force')
      };

      const stats = await runBackfill(options);

      console.log('\n--- Backfill Summary ---');
      console.log(`  Files found:    ${stats.filesFound}`);
      console.log(`  Processed:      ${stats.filesProcessed}`);
      console.log(`  Skipped:        ${stats.filesSkipped}`);
      console.log(`  Sessions:       ${stats.sessionsCreated}`);
      console.log(`  Observations:   ${stats.observationsSent}`);
      console.log(`  Errors:         ${stats.errors}`);
      return stats.errors > 0 ? 1 : 0;
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
      console.log('Usage: claude-mem transcript <init|watch|backfill|validate>');
      console.log('');
      console.log('Commands:');
      console.log('  init       Create sample transcript-watch.json config');
      console.log('  watch      Start live transcript watcher');
      console.log('  backfill   Import historical Claude Code sessions');
      console.log('  validate   Validate transcript-watch.json config');
      console.log('');
      console.log('Backfill options:');
      console.log('  --path <glob>   JSONL file pattern (default: ~/.claude/projects/**/*.jsonl)');
      console.log('  --dry-run       Preview without submitting');
      console.log('  --limit <n>     Max files to process');
      console.log('  --delay <ms>    Delay between sessions in ms (default: 500)');
      console.log('  --force         Re-process already-processed files');
      return 1;
  }
}
