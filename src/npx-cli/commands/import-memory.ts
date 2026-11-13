/** Explicit, model-free imports. Remote reads finish before any local write. */
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { getWorkerBaseUrl, withWorkerAuth } from '../../shared/worker-utils.js';

export const IMPORT_PROVIDERS = ['mem0', 'supermemory'] as const;
export type ImportProvider = typeof IMPORT_PROVIDERS[number];
type Row = Record<string, unknown>;
export interface ImportOptions {
  provider: ImportProvider;
  /** Stable caller-owned account label, retained when the API key rotates. */
  account: string;
  scope: string;
  project: string;
  documents?: boolean;
  maxRecords?: number;
  timeoutMs?: number;
}
export interface ImportNote { text: string; title: string; project: string; metadata: Row }
export interface ImportPlan { notes: ImportNote[]; scanned: number; skipped: number }
const LIMIT = 100;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;

function object(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object.');
  return value as Row;
}
function required(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`);
  return value;
}
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, stable(v)]));
  return value;
}
function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}
export function validateImportOptions(options: ImportOptions): void {
  if (!IMPORT_PROVIDERS.includes(options.provider)) throw new Error('Choose --from mem0 or supermemory.');
  required(options.account, '--source-account'); required(options.scope, 'Source user or namespace'); required(options.project, '--project');
  if (options.documents && options.provider !== 'supermemory') throw new Error('--documents is supported only with Supermemory.');
  if (options.provider === 'supermemory' && !/^[a-zA-Z0-9_:-]{1,100}$/.test(options.scope)) throw new Error('Invalid Supermemory namespace.');
  if (!Number.isSafeInteger(options.maxRecords ?? 10000) || (options.maxRecords ?? 10000) < 1 || (options.maxRecords ?? 10000) > 100000) throw new Error('--max-records must be between 1 and 100000.');
  if (!Number.isSafeInteger(options.timeoutMs ?? 15000) || (options.timeoutMs ?? 15000) < 1 || (options.timeoutMs ?? 15000) > 120000) throw new Error('--timeout-ms must be between 1 and 120000.');
}

/** No response bodies or raw fetch errors reach diagnostics: either can contain credentials or source text. */
export async function requestJson(url: string, init: RequestInit, timeoutMs: number, fetcher: typeof fetch = fetch): Promise<unknown> {
  try {
    const response = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Empty response');
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const next = await reader.read(); if (next.done) break;
        size += next.value.byteLength;
        if (size > MAX_BYTES) { await reader.cancel(); throw new Error('Response exceeds 16 MiB'); }
        chunks.push(next.value);
      }
    } finally { reader.releaseLock(); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new Error('Invalid JSON response'); }
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/^(HTTP \d{3}|Empty response|Response exceeds 16 MiB|Invalid JSON response)$/.test(message)) throw new Error(message);
    throw new Error('Request failed or timed out. Check connectivity and credentials.');
  }
}

/** Uses fixed vendor origins; pagination links are never followed with credentials. */
export async function collectImportRows(options: ImportOptions, apiKey: string, fetcher: typeof fetch = fetch): Promise<Row[]> {
  validateImportOptions(options); required(apiKey, 'Source API key');
  const rows: Row[] = []; const ids = new Set<string>(); const cursors = new Set<string>();
  let page = 1; let cursor: string | undefined; let expectedCount: number | undefined; let bytes = 0;
  while (true) {
    const url = options.provider === 'mem0' ? new URL('https://api.mem0.ai/v3/memories/')
      : new URL(`https://api.supermemory.ai/ns/${encodeURIComponent(options.scope)}/list/${options.documents ? 'documents' : 'memories'}`);
    url.searchParams.set(options.provider === 'mem0' ? 'page_size' : 'limit', String(LIMIT));
    if (cursor) url.searchParams.set('cursor', cursor); else url.searchParams.set('page', String(page));
    if (options.provider === 'supermemory') { url.searchParams.set('sort', 'createdAt'); url.searchParams.set('order', 'asc'); }
    const body = options.provider === 'mem0' ? { filters: { user_id: options.scope }, show_expired: false }
      : { include: options.documents ? { content: true } : { forgotten: false } };
    const result = object(await requestJson(url.href, { method: 'POST', headers: {
      Authorization: `${options.provider === 'mem0' ? 'Token' : 'Bearer'} ${apiKey}`, 'Content-Type': 'application/json',
    }, body: JSON.stringify(body) }, options.timeoutMs ?? 15000, fetcher));
    bytes += Buffer.byteLength(JSON.stringify(result));
    if (bytes > MAX_TOTAL_BYTES) throw new Error('Export exceeds 100 MiB; narrow the selected source.');
    const entries = result[options.provider === 'mem0' ? 'results' : options.documents ? 'documents' : 'memories'];
    if (!Array.isArray(entries)) throw new Error('Source returned an invalid page.');
    const pagination = options.provider === 'mem0' ? result : object(result.pagination);
    const count = pagination[options.provider === 'mem0' ? 'count' : 'totalItems'];
    if (page === 1) {
      if (!Number.isSafeInteger(count) || (count as number) < 0) throw new Error('Source returned an invalid total.');
      expectedCount = count as number;
      if (expectedCount > (options.maxRecords ?? 10000)) throw new Error('Source exceeds --max-records; no memories were written.');
    } else if (!cursor && count !== expectedCount) throw new Error('Source total changed during export; retry with a quiet source.');
    for (const entry of entries) {
      const row = object(entry); const id = required(row.id, 'Source record ID');
      if (ids.has(id)) throw new Error('Duplicate source ID during pagination; retry with a quiet source.');
      ids.add(id); rows.push(row);
      if (rows.length > (options.maxRecords ?? 10000)) throw new Error('Source exceeds --max-records.');
    }
    const more = options.provider === 'mem0' ? pagination.next !== null : pagination.hasMore;
    if (typeof more !== 'boolean' || (options.provider === 'mem0' && pagination.next !== null && typeof pagination.next !== 'string')) throw new Error('Invalid pagination state.');
    if (!more) break;
    if (!entries.length) throw new Error('Source returned an empty intermediate page.');
    if (options.provider === 'supermemory') {
      const next = required(pagination.nextCursor, 'Pagination cursor');
      if (cursors.has(next)) throw new Error('Source repeated a pagination cursor.');
      cursors.add(next); cursor = next;
    }
    page++;
    if (page > (options.maxRecords ?? 10000) + 1) throw new Error('Source pagination limit exceeded.');
  }
  if (rows.length !== expectedCount) throw new Error('Export count does not match the source total; no memories were written.');
  return rows;
}

export function planImport(rows: Row[], options: ImportOptions, now = Date.now()): ImportPlan {
  validateImportOptions(options); const notes: ImportNote[] = []; const ids = new Set<string>(); let skipped = 0;
  if (rows.length > (options.maxRecords ?? 10000)) throw new Error('Source exceeds --max-records.');
  for (const row of rows) {
    const id = required(row.id, 'Source record ID');
    if (ids.has(id)) throw new Error('Duplicate source record ID.'); ids.add(id);
    if (options.provider === 'mem0') {
      if (row.user_id !== undefined && row.user_id !== null && row.user_id !== options.scope) throw new Error('Mem0 returned a different user.');
      if (row.lifecycle_state !== undefined && !['active', 'merged', 'superseded'].includes(row.lifecycle_state as string)) throw new Error('Unrecognized Mem0 lifecycle state.');
      if (row.replaced_by || row.replacement_memory_id || ['merged', 'superseded'].includes(row.lifecycle_state as string)) { skipped++; continue; }
      if (row.expiration_date) {
        const expiry = Date.parse(required(row.expiration_date, 'Expiration date'));
        if (!Number.isFinite(expiry)) throw new Error('Invalid source expiration date.');
        if (expiry <= now) { skipped++; continue; }
      }
    } else if (!options.documents) {
      if (typeof row.isForgotten !== 'boolean' || typeof row.isLatest !== 'boolean') throw new Error('Missing Supermemory lifecycle flags.');
      if (row.isForgotten || !row.isLatest) { skipped++; continue; }
    } else if (object(row.system).status !== 'done') { throw new Error('A source document is not ready; wait for processing to finish.'); }
    const text = required(row[options.documents ? 'content' : 'memory'], 'Source text');
    if (text.length > 100000) throw new Error('A source record exceeds 100000 characters; split it before importing.');
    // Raw source metadata is nested, never promoted into worker control fields.
    const source = { provider: options.provider, account: options.account, scope: options.scope,
      kind: options.documents ? 'document' : 'memory', id, record: row };
    const revision = hash(source);
    const metadata = { platformSource: options.provider, sourceFingerprint: `import:${options.provider}:${revision}`, importSource: source };
    // The worker also deduplicates identical title/text within its manual session.
    // Include full revision identity so different accounts or metadata-only edits
    // cannot collapse and lose their provenance before fingerprint replay lookup.
    const note = { text, title: `${options.provider === 'mem0' ? 'Mem0' : 'Supermemory'} ${options.documents ? 'document' : 'memory'} ${id} (${revision})`, project: options.project, metadata };
    if (Buffer.byteLength(JSON.stringify(note)) > 900000) throw new Error('A source record and metadata exceed the import size limit.');
    notes.push(note);
  }
  return { notes, scanned: rows.length, skipped };
}

export async function applyImport(plan: ImportPlan, save: (note: ImportNote) => Promise<unknown>): Promise<{ imported: number; existing: number }> {
  let imported = 0; let existing = 0;
  for (const note of plan.notes) {
    try {
      const result = object(await save(note));
      if (result.success !== true || !Number.isSafeInteger(result.id) || (result.id as number) <= 0 || result.project !== note.project) throw new Error('Worker did not confirm the saved memory in the selected project.');
      if (result.duplicate === true) existing++; else imported++;
    } catch (error) {
      throw new Error(`Import stopped after ${imported} new and ${existing} existing memories. ${error instanceof Error ? error.message : 'Save failed.'} Run the same command again to resume; confirmed records will not duplicate.`);
    }
  }
  return { imported, existing };
}

export async function runImportCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: {
    from: { type: 'string' }, 'source-account': { type: 'string' }, user: { type: 'string' }, namespace: { type: 'string' },
    project: { type: 'string' }, documents: { type: 'boolean' }, 'dry-run': { type: 'boolean' },
    'max-records': { type: 'string' }, 'timeout-ms': { type: 'string' },
  }, strict: true, allowPositionals: false });
  if (values.from === 'mem0' && values.namespace || values.from === 'supermemory' && values.user) throw new Error('Use --user for Mem0 or --namespace for Supermemory.');
  const options: ImportOptions = { provider: values.from as ImportProvider, account: values['source-account']!,
    scope: (values.from === 'mem0' ? values.user : values.namespace)!, project: values.project!, documents: values.documents,
    maxRecords: values['max-records'] === undefined ? undefined : Number(values['max-records']),
    timeoutMs: values['timeout-ms'] === undefined ? undefined : Number(values['timeout-ms']),
  };
  validateImportOptions(options);
  const keyName = options.provider === 'mem0' ? 'MEM0_API_KEY' : 'SUPERMEMORY_API_KEY';
  const apiKey = required(process.env[keyName], keyName);
  // Resolve/authenticate the destination separately. Never forward a vendor key.
  const base = getWorkerBaseUrl({ readOnly: true });
  const init = withWorkerAuth({ method: 'POST', headers: { 'Content-Type': 'application/json' } }, { readOnly: true });
  console.log(`Reading ${options.provider} ${options.documents ? 'documents' : 'memories'}…`);
  const plan = planImport(await collectImportRows(options, apiKey), options);
  console.log(`${plan.scanned} read; ${plan.skipped} skipped; ${plan.notes.length} ready to import.`);
  if (values['dry-run']) { console.log('Dry run complete. No memories were written.'); return; }
  const result = await applyImport(plan, note => requestJson(`${base}/api/memory/save`, {
    ...init, body: JSON.stringify({ ...note, cwd: process.cwd() }),
  }, options.timeoutMs ?? 15000));
  console.log(`Import complete: ${result.imported} new, ${result.existing} already imported, ${plan.skipped} skipped.`);
}
