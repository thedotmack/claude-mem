import { Database } from 'bun:sqlite';
import { startDeepSearchGuard } from './guard.js';
import { emptyDeepResult, searchToolUses } from '../sqlite/tool-use-search.js';
import { MAX_REPLY_BYTES, MAX_REQUEST_BYTES, type DeepSearchRequest } from './protocol.js';

async function main() {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) throw new Error('Request too large');
    chunks.push(chunk);
  }
  const request: DeepSearchRequest = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (request.version !== 1 || !Number.isSafeInteger(request.id) || !Number.isSafeInteger(request.parentPid)
    || !Number.isFinite(request.deadline) || typeof request.query !== 'string' || typeof request.dbPath !== 'string') {
    throw new Error('Invalid request');
  }
  const guard = await startDeepSearchGuard(request.parentPid, request.deadline);
  let db: Database | undefined;
  let result;
  try {
    if (Date.now() >= request.deadline) result = emptyDeepResult('timeout');
    else {
      db = new Database(request.dbPath, { readonly: true, create: false });
      db.run('PRAGMA query_only = ON; PRAGMA busy_timeout = 0;');
      result = searchToolUses(db, request.query, request.options);
    }
  } catch { result = emptyDeepResult('error'); }
  finally { db?.close(); }
  const reply = JSON.stringify({ version: 1, id: request.id, result });
  const output = Buffer.byteLength(reply) <= MAX_REPLY_BYTES ? reply
    : JSON.stringify({ version: 1, id: request.id, result: emptyDeepResult('error') });
  try {
    // Keep the guard armed through transport completion. Do not use exit(0):
    // pending pipe writes must be allowed to drain, including on Windows.
    await new Promise<void>((resolve, reject) => process.stdout.write(output, error => error ? reject(error) : resolve()));
  } finally { await guard.terminate(); }
}

main().catch(() => { process.exitCode = 1; });
