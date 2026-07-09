import { DEFAULT_CONFIG_PATH, DEFAULT_STATE_PATH, expandHomePath, loadTranscriptWatchConfig, writeSampleConfig } from './config.js';
import { TranscriptWatcher } from './watcher.js';
import { dryRunSource, formatDryRunReport } from './ingest.js';
import { ensureWorkerRunning, workerHttpRequest } from '../../shared/worker-utils.js';

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
      // setIngestContext, so it runs INSIDE the worker. Drive it over HTTP.
      const workerReady = await ensureWorkerRunning();
      if (!workerReady) {
        console.error('Worker is not running and could not be started. Cannot ingest.');
        return 1;
      }
      const response = await workerHttpRequest('/api/transcript/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source, includeSubagents }),
        timeoutMs: 0, // backfill can be long; do not time out
      });
      if (!response.ok) {
        console.error(`Ingest failed: HTTP ${response.status} ${await response.text()}`);
        return 1;
      }
      const report = await response.json() as {
        found: number; ingested: number; alreadyIndexed: number; failed: number;
        sessions: Array<{ sessionId: string; isSubagent: boolean; status: string; observations: number; reason?: string }>;
      };
      for (const s of report.sessions) {
        const tag = s.isSubagent ? '  subagent' : 'session';
        console.log(`${tag} ${s.sessionId}: ${s.status}${s.reason ? ` (${s.reason})` : ''}, ${s.observations} obs`);
      }
      console.log(
        `INGESTED: ${report.ingested} new, ${report.alreadyIndexed} already-indexed, ` +
          `${report.failed} failed, of ${report.found} found.`
      );
      return report.failed > 0 ? 1 : 0;
    }
    default:
      console.log('Usage: claude-mem transcript <init|watch|validate|ingest> [--config <path>]');
      return 1;
  }
}
