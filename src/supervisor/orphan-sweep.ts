/**
 * Boot-time system-wide sweep for LEAKED chroma-mcp trees (#3216/#3218).
 *
 * Complements the registry-only reap (reapLeakedProcesses in shutdown.ts):
 * that one can only kill pids still recorded in supervisor.json, so it misses
 * orphans whose registry entry was lost — overwritten under the old fixed key,
 * dropped on a registry-parse failure, or predating registry tracking. This
 * sweep finds those by scanning the live process table for chroma-mcp processes
 * that (a) point at OUR data-dir and (b) have re-parented to init / systemd --user
 * (the tell-tale of an orphan), then tree-kills them.
 *
 * Split into a PURE classifier (parsePsOutput + findOrphanedChromaPids, unit-
 * tested deterministically) and a thin imperative shell that gathers `ps`
 * output and does the killing.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { logger } from '../utils/logger.js';
import { paths } from '../shared/paths.js';
import { isPidAlive, type ProcessRegistry } from './process-registry.js';
import { killProcessTree } from './tree-kill.js';

const execFileAsync = promisify(execFile);

// Must match REAP_CMDLINE_MARKERS.chroma in shutdown.ts and the chroma-mcp
// package name emitted by buildCommandArgs() in ChromaMcpManager.
const CHROMA_MCP_CMDLINE_MARKER = 'chroma-mcp';

export interface PsRow {
  pid: number;
  ppid: number;
  args: string;
}

/** Parse `ps -eo pid,ppid,args` output; skips the header and any blank/garbage lines. */
export function parsePsOutput(stdout: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of stdout.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue; // header ("PID PPID ARGS") and blanks fall through here
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), args: match[3] });
  }
  return rows;
}

/**
 * Pure orphan classifier. A row is a leaked chroma-mcp tree to reap when:
 *  - its cmdline contains 'chroma-mcp' AND '--data-dir <chromaDataDir>' (ours), and
 *  - its parent is init (PID 1) OR a `systemd --user` manager (the subreaper an
 *    orphaned grandchild re-parents to on systemd hosts — a PPID==1-only check
 *    silently reaps nothing there, #3218), and
 *  - it is not in excludePids (our own live chroma pids / this process).
 */
export function findOrphanedChromaPids(
  rows: readonly PsRow[],
  chromaDataDir: string,
  excludePids: ReadonlySet<number>,
): number[] {
  const systemdUserPids = rows
    .filter(row => row.args.trim().startsWith('systemd --user'))
    .map(row => row.pid);
  const orphanParents = new Set<number>([1, ...systemdUserPids]);
  const dataDirMarker = `--data-dir ${chromaDataDir}`;

  const orphans: number[] = [];
  for (const row of rows) {
    if (excludePids.has(row.pid)) continue;
    if (!row.args.includes(CHROMA_MCP_CMDLINE_MARKER)) continue;
    if (!row.args.includes(dataDirMarker)) continue;
    if (!orphanParents.has(row.ppid)) continue;
    orphans.push(row.pid);
  }
  return orphans;
}

/**
 * Scan the process table and tree-kill every leaked chroma-mcp orphan pointing
 * at our data-dir. Runs at worker boot (after reapLeakedProcesses, before the
 * server listens) so no chroma-mcp we legitimately spawn this run is in the
 * snapshot yet. POSIX-only; best-effort (never throws, never blocks boot).
 * Returns the number of trees reaped.
 */
export async function reapOrphanedChromaProcesses(registry: ProcessRegistry): Promise<number> {
  if (process.platform === 'win32') return 0;

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('ps', ['-eo', 'pid,ppid,args'], { timeout: 5_000 }));
  } catch (error: unknown) {
    logger.debug('SYSTEM', 'Orphan sweep skipped — ps unavailable', {
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }

  const rows = parsePsOutput(stdout);
  // Never sweep our own live chroma children (per-pid registry entries) or this
  // very process — belt-and-suspenders on top of the parent-pid classification.
  const excludePids = new Set<number>(
    registry.getAll().filter(record => record.type === 'chroma').map(record => record.pid),
  );
  excludePids.add(process.pid);

  const orphans = findOrphanedChromaPids(rows, paths.chroma(), excludePids);
  if (orphans.length === 0) return 0;

  let reaped = 0;
  for (const pid of orphans) {
    if (!isPidAlive(pid)) continue;
    logger.warn('SYSTEM', 'Reaping orphaned chroma-mcp tree left by a previous run (re-parented to init/systemd --user, not in registry)', { pid });
    try {
      await killProcessTree(pid);
      reaped += 1;
    } catch (error: unknown) {
      logger.debug('SYSTEM', 'Failed to reap orphaned chroma-mcp tree', { pid },
        error instanceof Error ? error : new Error(String(error)));
    }
  }
  return reaped;
}
