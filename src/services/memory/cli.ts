import {
  dryRunMemorySource,
  formatMemoryDryRunReport,
  memoryDirForCwd,
  claudeProjectsDir,
  type MemoryIngestReport,
} from './ingest.js';
import { resolve } from 'path';
import { ensureWorkerRunning, workerHttpRequest } from '../../shared/worker-utils.js';
import { expandHome } from '../../shared/expand-home.js';

function getArgValue(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] ?? null;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

const USAGE =
  'Usage: claude-mem memory ingest [--source <dir> | --all] [--dry-run] [--require-cwd]\n' +
  '  default: the current repo\'s memory dir (cwd)\n' +
  '  --all:   sweep every ~/.claude/projects/*/memory/\n' +
  '  --dry-run:     zero-spend scan + count (do this first)\n' +
  '  --require-cwd: skip orphaned dirs whose cwd cannot be resolved';

/**
 * Resolve the effective source dir from flags (default = the caller's repo
 * memory). The npx CLI runs this from the plugin root and passes the directory
 * the user ran it in as --cwd, as it does for adopt; process.cwd() is only the
 * fallback for a direct invocation. A relative --source is relative to it too.
 */
function resolveSource(args: string[]): { source: string; all: boolean } {
  const all = hasFlag(args, '--all');
  if (all) return { source: claudeProjectsDir(), all: true };
  const callerCwd = resolve(getArgValue(args, '--cwd') ?? process.cwd());
  const explicit = getArgValue(args, '--source');
  if (explicit) return { source: resolve(callerCwd, expandHome(explicit)), all: false };
  return { source: memoryDirForCwd(callerCwd), all: false };
}

export async function runMemoryCommand(subcommand: string | undefined, args: string[]): Promise<number> {
  switch (subcommand) {
    case 'ingest': {
      const { source, all } = resolveSource(args);

      // Dry-run is pure parse + count — no worker, no spend — so run it here.
      if (hasFlag(args, '--dry-run')) {
        try {
          console.log(formatMemoryDryRunReport(dryRunMemorySource(source, { all })));
          return 0;
        } catch (error) {
          console.error(error instanceof Error ? error.message : String(error));
          return 1;
        }
      }

      // Real ingest stores into the SQLite observation DB, which lives in the
      // worker. Drive it over HTTP, as summaries reach it.
      const workerReady = await ensureWorkerRunning();
      if (!workerReady) {
        console.error('Worker is not running and could not be started. Cannot ingest.');
        return 1;
      }
      const response = await workerHttpRequest('/api/memory/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source, all, requireCwd: hasFlag(args, '--require-cwd') }),
        timeoutMs: 0, // bulk import can be long; do not time out
      });
      if (!response.ok) {
        console.error(`Memory ingest failed: HTTP ${response.status} ${await response.text()}`);
        return 1;
      }

      const report = (await response.json()) as MemoryIngestReport;
      // Every file but an already-imported one is listed, so a skipped note
      // (a symlink, or one over the size cap) is named with its reason.
      for (const f of report.files) {
        if (f.status !== 'deduped') {
          console.log(`${f.project}/${f.file}: ${f.status}${f.reason ? ` (${f.reason})` : ''}` +
            (f.observationId ? ` -> obs #${f.observationId}` : ''));
        }
      }
      console.log(
        `MEMORY INGEST: ${report.stored} stored, ${report.deduped} already-imported, ` +
          `${report.skipped} skipped, ${report.failed} failed, of ${report.found} files ` +
          `across ${report.dirs} dirs` +
          (report.cwdUnresolvedDirs ? ` (${report.cwdUnresolvedDirs} orphaned/cwd-unresolved)` : '')
      );
      return report.failed > 0 ? 1 : 0;
    }
    default:
      console.log(USAGE);
      return subcommand ? 1 : 0;
  }
}
