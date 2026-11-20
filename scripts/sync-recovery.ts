#!/usr/bin/env bun
/** Explicit operator interface for the guarded local recovery routes.
 * Preview commands only read. Creating a job starts it paused; resume is separate.
 */
import { readFile } from 'node:fs/promises';

const HELP = `Usage: bun scripts/sync-recovery.ts [--worker http://127.0.0.1:37777] COMMAND
  inventory
  preview --scope scope.json
  create --preview preview.json
  jobs
  job JOB_ID
  resume JOB_ID --epoch EPOCH
  pause JOB_ID
  cancel JOB_ID
  conflicts
  conflict-preview --kind KIND --id ORIGIN_LOCAL_ID --choice local_current
  conflict-apply --review review.json
Scope requires project, from, to and kinds. Save preview JSON before creating a job.
Recovery changes the selected history only; it does not enable complete mirroring.`;

export interface RecoveryCliIo {
  fetch: typeof fetch;
  readJson: (path: string) => Promise<unknown>;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object.');
  return value as Record<string, unknown>;
}

export async function runRecoveryCommand(argv: string[], io: RecoveryCliIo): Promise<unknown> {
  const args = [...argv];
  let worker = 'http://127.0.0.1:37777';
  if (args[0] === '--worker') {
    args.shift();
    worker = args.shift() ?? '';
  }
  let url: URL;
  try { url = new URL(worker); } catch { throw new Error('Worker URL must be loopback HTTP.'); }
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Worker URL must be loopback HTTP with no path or credentials.');
  }
  const command = args.shift();
  if (!command || command === '--help' || command === 'help') return { usage: HELP };
  function option(name: string): string {
    const at = args.indexOf(name);
    if (at === -1 || !args[at + 1] || args[at + 1].startsWith('--')) throw new Error(`Missing ${name}.`);
    const value = args[at + 1];
    args.splice(at, 2);
    return value;
  }
  function identity(): string {
    const id = args.shift();
    if (!id || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('Invalid job identifier.');
    return id;
  }
  let path: string;
  let body: unknown;
  if (command === 'inventory') path = '/inventory';
  else if (command === 'jobs') path = '/jobs';
  else if (command === 'job') path = `/jobs/${identity()}`;
  else if (command === 'conflicts') path = '/conflicts';
  else if (command === 'preview') { path = '/preview'; body = await io.readJson(option('--scope')); }
  else if (command === 'create') {
    const preview = record(await io.readJson(option('--preview')));
    path = '/jobs';
    body = { scope: preview.scope, previewToken: preview.previewToken };
  } else if (['resume', 'pause', 'cancel'].includes(command)) {
    path = `/jobs/${identity()}/transition`;
    const epoch = command === 'resume' ? option('--epoch') : null;
    body = command === 'resume' ? { action: command, expectedEpoch: epoch === 'null' ? null : epoch } : { action: command };
  } else if (command === 'conflict-preview') {
    path = '/conflicts/preview';
    body = { kind: option('--kind'), originLocalId: option('--id'), choice: option('--choice') };
  } else if (command === 'conflict-apply') {
    path = '/conflicts/apply';
    const review = record(await io.readJson(option('--review')));
    body = { previewToken: review.previewToken };
  } else throw new Error('Unknown recovery command. Use --help.');
  if (args.length) throw new Error('Unexpected recovery arguments.');
  const response = await io.fetch(`${url.origin}/api/sync/recovery${path}`, {
    redirect: 'error',
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const result = await response.json();
  if (!response.ok) {
    // Server errors are already privacy-safe; never print raw bodies from other endpoints.
    const code = record(result).code;
    throw new Error(`Recovery request failed (${response.status}${typeof code === 'string' ? `: ${code}` : ''}).`);
  }
  return result;
}

if (import.meta.main) {
  try {
    const result = await runRecoveryCommand(process.argv.slice(2), {
      fetch,
      readJson: async path => {
        const text = await readFile(path, 'utf8');
        if (Buffer.byteLength(text, 'utf8') > 1_000_000) throw new Error('Review file is too large.');
        return JSON.parse(text);
      },
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Recovery command failed.');
    process.exitCode = 1;
  }
}
