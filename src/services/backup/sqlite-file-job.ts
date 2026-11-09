/**
 * Whole-file SQLite work (VACUUM INTO, quick_check, journal-mode switch, WAL
 * checkpoint) runs in a child Bun process. bun:sqlite is synchronous, and on a
 * multi-GB database each of these takes tens of seconds; run in the worker it
 * would stall every HTTP request and the health check for that long.
 *
 * The child script is the one implementation of these steps. It reads its
 * job from an env var, prints one JSON result line, and exits non-zero with
 * an `ERROR:` line on failure.
 */

import { sanitizeEnv } from '../../supervisor/env-sanitizer.js';

export type SqliteFileJob =
  /** VACUUM INTO `target` from `source`, then make it standalone. */
  | { kind: 'snapshot'; source: string; target: string }
  /** Fold any `-wal` into `target`, switch it to rollback-journal mode, require quick_check ok. */
  | { kind: 'standalone'; target: string; maxSchemaVersion?: number }
  /** PRAGMA wal_checkpoint(TRUNCATE) on `target`; reports whether another connection blocked it. */
  | { kind: 'checkpoint'; target: string };

export interface SqliteFileJobResult {
  busy?: boolean;
}

const CHILD_SCRIPT = String.raw`
const { Database } = require('bun:sqlite');
const fs = require('fs');
function rm(p) { try { fs.unlinkSync(p); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
function standalone(p, maxSchemaVersion) {
  const db = new Database(p, { readwrite: true, create: false });
  try {
    if (maxSchemaVersion !== undefined) {
      const stamp = db.query('PRAGMA user_version').get().user_version;
      if (stamp > maxSchemaVersion) {
        throw new Error('Snapshot has schema v' + stamp + '; this claude-mem knows up to schema v' + maxSchemaVersion + '. Upgrade claude-mem before restoring this snapshot.');
      }
    }
    db.run('PRAGMA journal_mode = DELETE');
    const r = db.query('PRAGMA quick_check').get();
    if (!r || r.quick_check !== 'ok') throw new Error('database failed quick_check: ' + (r ? r.quick_check : 'no result'));
  } finally { db.close(); }
  rm(p + '-wal'); rm(p + '-shm');
}
try {
  const job = JSON.parse(process.env.CLAUDE_MEM_SQLITE_FILE_JOB);
  const result = {};
  if (job.kind === 'checkpoint') {
    const db = new Database(job.target, { readwrite: true, create: false });
    try {
      const r = db.query('PRAGMA wal_checkpoint(TRUNCATE)').get();
      result.busy = !!(r && r.busy !== 0);
    } finally { db.close(); }
  } else {
    if (job.kind === 'snapshot') {
      // VACUUM INTO creates a new file rather than preserving source modes.
      // Keep the complete memory copy private from its first write. This is
      // a dedicated child, so the worker's process-wide umask is unchanged.
      if (process.platform !== 'win32') process.umask(0o077);
      // VACUUM INTO is the only consistent online copy. A raw copy of a live
      // db and its WAL can pair two different states, so there is no copy
      // fallback: a failed VACUUM INTO fails the snapshot.
      const src = new Database(job.source, { readonly: true });
      try { src.run("VACUUM INTO '" + job.target.replace(/'/g, "''") + "'"); }
      finally { src.close(); }
    }
    standalone(job.target, job.maxSchemaVersion);
  }
  process.stdout.write(JSON.stringify(result) + '\n');
} catch (e) {
  process.stderr.write('ERROR: ' + (e && e.message ? e.message : String(e)) + '\n');
  process.exit(1);
}
`;

function lastLine(text: string): string {
  const lines = text.trim().split('\n');
  return lines[lines.length - 1] ?? '';
}

export async function runSqliteFileJob(job: SqliteFileJob, signal?: AbortSignal): Promise<SqliteFileJobResult> {
  if (typeof Bun === 'undefined') {
    throw new Error('SQLite file jobs need the Bun runtime (the worker), not Node');
  }
  signal?.throwIfAborted();
  const child = Bun.spawn([process.execPath, '-e', CHILD_SCRIPT], {
    // BUN_BE_BUN makes a `bun build --compile` worker binary act as the bun
    // CLI for this child, so `-e` runs the script there too.
    env: { ...sanitizeEnv(process.env), BUN_BE_BUN: '1', CLAUDE_MEM_SQLITE_FILE_JOB: JSON.stringify(job) },
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
  });
  const abortChild = () => {
    // This handle names only our SQLite child. A snapshot's live source is
    // readonly; its disposable partial is removed after the child exits.
    try { child.kill('SIGKILL'); } catch { /* already exited */ }
  };
  signal?.addEventListener('abort', abortChild, { once: true });
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    signal?.throwIfAborted();
    if (exitCode !== 0) {
      const errorLine = stderr.split('\n').find(line => line.startsWith('ERROR: '));
      throw new Error(errorLine ? errorLine.slice('ERROR: '.length) : `sqlite ${job.kind} job exited ${exitCode}: ${lastLine(stderr)}`);
    }
    return JSON.parse(lastLine(stdout)) as SqliteFileJobResult;
  } catch (error) {
    // Failed pipe reads must not abandon a child either. Reap it before the
    // caller removes the partial, and keep cancellation's original reason.
    abortChild();
    await child.exited.catch(() => {});
    signal?.throwIfAborted();
    throw error;
  } finally {
    signal?.removeEventListener('abort', abortChild);
  }
}
