/** Explicit, model-free imports. Remote reads finish before any local write. */
import { constants as bufferConstants } from 'node:buffer';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { getWorkerApiRequestTimeoutMs, getWorkerBaseUrl, withWorkerAuth } from '../../shared/worker-utils.js';
import { WORKER_JSON_BODY_LIMIT_BYTES } from '../../shared/worker-http-limits.js';
import { CONTENT_BODY_MAX_BYTES, ORIGIN_DEVICE_ID_MAX_BYTES } from '../../shared/cloud-sync-limits.js';
import { isMemorySaveRefusalReason, type MemorySaveRefusalReason } from '../../shared/memory-save-refusal.js';
import { LOOKUP_ONLY_ALTERNATIVE_FINGERPRINT_KEY } from '../../shared/memory-save-replay.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';
import { isAbsoluteFilesystemPath, normalizeExplicitProject } from '../../utils/project-name.js';

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
  /** The caller's own gate (`--max-records`): refuse a larger source before any write. Unset, there is none. */
  maxRecords?: number;
  /**
   * Deadline for each source request and each save (`--timeout-ms`). Unset, source requests
   * use the vendors' own client default (SOURCE_TIMEOUT_MS) and saves the worker API deadline.
   */
  timeoutMs?: number;
  /**
   * Host platform the imported notes belong to (`--platform`). Unset, they land on
   * the default platform, so memory search on that host finds them.
   */
  platformSource?: string;
  /** Folder sent with every save. The worker refuses one listed in CLAUDE_MEM_EXCLUDED_PROJECTS. */
  cwd?: string;
}
export interface ImportNote { text: string; title: string; project: string; metadata: Row }
export interface ImportPlan {
  notes: ImportNote[];
  scanned: number;
  skipped: number;
  /** Mem0 memories imported as never expiring because their expiration date is not a date Mem0 can read. */
  memoriesWithUnreadableExpirationDate: number;
}

/**
 * Records per source page: each vendor's documented maximum, so a full read takes
 * the fewest requests. The command always reads every page, so it is not a choice.
 * - Mem0 `POST /v3/memories/`, `page_size`: "maximum: 200" ("Results per page.",
 *   https://docs.mem0.ai/api-reference/memory/get-memories).
 * - Supermemory `POST /ns/{namespace}/list/{type}`, `limit`: "maximum: 100"
 *   ("Maximum resources to return per page",
 *   https://supermemory.ai/docs/v5/api-reference/content-management/list-resources.md).
 */
const PAGE_SIZE: Record<ImportProvider, number> = { mem0: 200, supermemory: 100 };
/**
 * Deadline for one whole source request unless `--timeout-ms` sets it: the default of
 * both vendors' own JavaScript clients, so the import waits as long as they do.
 * - Mem0's `MemoryClient` (mem0ai): `axios.create({ baseURL: this.host, headers: ...,
 *   timeout: 60000 })` (https://github.com/mem0ai/mem0/blob/main/mem0-ts/src/client/mem0.ts).
 * - Supermemory's SDK page: "timeoutInSeconds: 30, // default 60"
 *   (https://supermemory.ai/docs/integrations/supermemory-sdk.md).
 */
const SOURCE_TIMEOUT_MS = 60_000;
/**
 * Largest `--timeout-ms`: Node's timer maximum. "When `delay` is larger than
 * `2147483647` or less than `1` or `NaN`, the `delay` will be set to `1`."
 * (https://nodejs.org/api/timers.html#settimeoutcallback-delay-args). AbortSignal.timeout
 * uses that timer, so a larger value would end every request after 1 ms.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;
/**
 * Largest response body requestJson reads: JSON.parse needs the body as one string,
 * and `buffer.constants.MAX_STRING_LENGTH` is "The largest length allowed for a single
 * `string` instance", counted in UTF-16 code units
 * (https://nodejs.org/api/buffer.html#bufferconstantsmax_string_length). A UTF-8 body
 * never decodes to more code units than it has bytes, so a body up to this size always
 * fits one string.
 */
const MAX_JSON_RESPONSE_BYTES = bufferConstants.MAX_STRING_LENGTH;
const RESUME = 'Run the same command again to resume; confirmed records will not duplicate.';
/**
 * Words for each worker refusal. A refusal comes back on every run until the setting
 * behind it changes, so none of these tells the user to run the same command again.
 */
const SAVE_REFUSALS: Record<MemorySaveRefusalReason, string> = {
  project_excluded: 'The worker refused to save from this folder because it matches CLAUDE_MEM_EXCLUDED_PROJECTS. '
    + 'Running the same command here will be refused again. Run it from a folder that is not excluded '
    + '(the memories still go to --project), or remove this folder from that setting.',
};
/**
 * An HTTP 413 also comes back on every run: planImport already keeps every save request
 * within WORKER_JSON_BODY_LIMIT_BYTES, so whatever answered accepts less than that.
 */
const SAVE_REQUEST_TOO_LARGE = `The worker refused a save as too large (HTTP 413), although every save from this command stays within the worker's ${WORKER_JSON_BODY_LIMIT_BYTES}-byte limit. `
  + 'The worker, or something in front of it, accepts less. Running the same command again will be refused the same way; '
  + 'check that the worker runs the same claude-mem version as this command.';

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
/**
 * The first UTC millisecond a Mem0 memory is hidden, or null when it never is.
 * https://docs.mem0.ai/platform/features/memory-expiration:
 * "Format: a plain `YYYY-MM-DD` date. No time component, no timezone offset."
 * "Evaluated in UTC, never against the caller's local timezone."
 * "Inclusive of the date itself: a memory set to expire on `2030-01-31` stays visible
 * all through `2030-01-31` UTC and disappears on `2030-02-01`."
 * "No expiration date means never expires."
 * "Malformed dates fail open: a stored value Mem0 can't parse is treated as *not*
 * expired. A bad date never makes a memory silently vanish."
 */
function mem0HiddenFrom(expirationDate: unknown): number | null {
  const match = typeof expirationDate === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(expirationDate) : null;
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return Date.UTC(year, month - 1, day + 1);
}
/** The exact POST /api/memory/save body for one note. */
export function saveRequestBody(note: ImportNote, cwd: string | undefined): string {
  return JSON.stringify({ ...note, cwd });
}
/** The longest canonical decimal cloud sync writes: a uint64 (CanonicalContent.ts assertCanonicalDecimal). */
const LONGEST_SYNC_DECIMAL = '18446744073709551615';
/**
 * An upper bound on the canonical body cloud sync builds for the observation a note
 * becomes: the observation `toBody` in src/services/sync/CloudSync.ts, wrapped by
 * `buildContentOperation` in src/services/sync/CanonicalContent.ts. The note's own fields
 * are as sent (the worker trims the title and text, which only shortens them, and a worker
 * that knows the lookup-only fingerprint leaves it out). Every value the worker or the sync
 * picks later is at its longest: each decimal a uint64, the content hash `details-` and 64
 * hex digits, the manual session id with its UUID suffix, a timestamp with a six-digit year,
 * and a device id of ORIGIN_DEVICE_ID_MAX_BYTES control characters, 6 bytes each as JSON.
 * Key order changes no length, so JSON.stringify of this measures what the sync's
 * canonicalJson writes. tests/worker/sync/import-sync-body-bound.test.ts builds the real body
 * for a saved note and checks every field of it against this one.
 */
export function observationSyncBodyBound(note: ImportNote): Row {
  const platform = normalizePlatformSource(typeof note.metadata.platformSource === 'string' ? note.metadata.platformSource : undefined);
  const storedProject = isAbsoluteFilesystemPath(note.project) ? normalizeExplicitProject(note.project) : note.project;
  return {
    body_schema_version: 1, deleted: false, deleted_at: null, entity_rev: LONGEST_SYNC_DECIMAL,
    id: `observation:${'0'.repeat(43)}`, kind: 'observation', mutation: null,
    origin_device_id: '\u0000'.repeat(ORIGIN_DEVICE_ID_MAX_BYTES), origin_local_id: LONGEST_SYNC_DECIMAL,
    payload: {
      memory_session_id: `manual-${storedProject}-${platform}-${'0'.repeat(36)}`,
      project: storedProject, text: null, type: 'discovery', title: note.title, subtitle: 'Manual memory',
      facts: [], narrative: note.text, concepts: [], files_read: [], files_modified: [],
      prompt_number: LONGEST_SYNC_DECIMAL, discovery_tokens: LONGEST_SYNC_DECIMAL,
      content_hash: `details-${'0'.repeat(64)}`, generated_by_model: null, agent_type: null, agent_id: null,
      metadata: note.metadata, merged_into_project: null, created_at: '+275760-09-13T00:00:00.000Z',
      created_at_epoch: LONGEST_SYNC_DECIMAL,
    },
    payload_schema_version: 2, payload_sha256: '0'.repeat(43),
  };
}
export function validateImportOptions(options: ImportOptions): void {
  if (!IMPORT_PROVIDERS.includes(options.provider)) throw new Error('Choose --from mem0 or supermemory.');
  required(options.account, '--source-account'); required(options.scope, 'Source user or namespace'); required(options.project, '--project');
  if (options.documents && options.provider !== 'supermemory') throw new Error('--documents is supported only with Supermemory.');
  // The namespace path parameter is "maxLength: 100" with "pattern: ^[a-zA-Z0-9_:-]+$"
  // (https://supermemory.ai/docs/v5/api-reference/content-management/list-resources.md).
  if (options.provider === 'supermemory' && !/^[a-zA-Z0-9_:-]{1,100}$/.test(options.scope)) throw new Error('Invalid Supermemory namespace.');
  if (options.maxRecords !== undefined && (!Number.isSafeInteger(options.maxRecords) || options.maxRecords < 1)) throw new Error('--max-records must be a whole number of at least 1.');
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > MAX_TIMER_DELAY_MS)) throw new Error(`--timeout-ms must be between 1 and ${MAX_TIMER_DELAY_MS}.`);
  if (options.platformSource !== undefined) required(options.platformSource, '--platform');
}

/** No response bodies or raw fetch errors reach diagnostics: either can contain credentials or source text. */
export async function requestJson(url: string, init: RequestInit, timeoutMs: number, fetcher: typeof fetch = fetch, maxBytes = MAX_JSON_RESPONSE_BYTES): Promise<unknown> {
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
        if (size > maxBytes) { await reader.cancel(); throw new Error(`Response exceeds ${maxBytes} bytes`); }
        chunks.push(next.value);
      }
    } finally { reader.releaseLock(); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new Error('Invalid JSON response'); }
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/^(HTTP \d{3}|Empty response|Response exceeds \d+ bytes|Invalid JSON response)$/.test(message)) throw new Error(message);
    throw new Error('Request failed or timed out. Check connectivity and credentials.');
  }
}

/** Uses fixed vendor origins; pagination links are never followed with credentials. */
export async function collectImportRows(options: ImportOptions, apiKey: string, fetcher: typeof fetch = fetch, onSourceTotal?: (total: number) => void): Promise<Row[]> {
  validateImportOptions(options); required(apiKey, 'Source API key');
  const pageSize = PAGE_SIZE[options.provider];
  // A page's one byte limit is requestJson's: the largest response it can parse
  // (MAX_JSON_RESPONSE_BYTES). The per-record limits give no tighter one, because a
  // vendor's JSON can spell a record longer than the save request does (escapes,
  // whitespace), so a longer page can still hold only records that fit.
  const timeoutMs = options.timeoutMs ?? SOURCE_TIMEOUT_MS;
  const rows: Row[] = []; const ids = new Set<string>(); const cursors = new Set<string>();
  let page = 1; let cursor: string | undefined; let expectedCount = 0;
  while (true) {
    const url = options.provider === 'mem0' ? new URL('https://api.mem0.ai/v3/memories/')
      : new URL(`https://api.supermemory.ai/ns/${encodeURIComponent(options.scope)}/list/${options.documents ? 'documents' : 'memories'}`);
    url.searchParams.set(options.provider === 'mem0' ? 'page_size' : 'limit', String(pageSize));
    if (cursor) url.searchParams.set('cursor', cursor); else url.searchParams.set('page', String(page));
    if (options.provider === 'supermemory') { url.searchParams.set('sort', 'createdAt'); url.searchParams.set('order', 'asc'); }
    const body = options.provider === 'mem0' ? { filters: { user_id: options.scope }, show_expired: false }
      : { include: options.documents ? { content: true } : { forgotten: false } };
    const result = object(await requestJson(url.href, { method: 'POST', headers: {
      Authorization: `${options.provider === 'mem0' ? 'Token' : 'Bearer'} ${apiKey}`, 'Content-Type': 'application/json',
    }, body: JSON.stringify(body) }, timeoutMs, fetcher));
    const entries = result[options.provider === 'mem0' ? 'results' : options.documents ? 'documents' : 'memories'];
    if (!Array.isArray(entries)) throw new Error('Source returned an invalid page.');
    const pagination = options.provider === 'mem0' ? result : object(result.pagination);
    const count = pagination[options.provider === 'mem0' ? 'count' : 'totalItems'];
    if (page === 1) {
      if (!Number.isSafeInteger(count) || (count as number) < 0) throw new Error('Source returned an invalid total.');
      expectedCount = count as number;
      if (options.maxRecords !== undefined && expectedCount > options.maxRecords) throw new Error('Source exceeds --max-records; no memories were written.');
      onSourceTotal?.(expectedCount);
    } else if (!cursor && count !== expectedCount) throw new Error('Source total changed during export; retry with a quiet source.');
    for (const entry of entries) {
      const row = object(entry); const id = required(row.id, 'Source record ID');
      if (ids.has(id)) throw new Error('Duplicate source ID during pagination; retry with a quiet source.');
      ids.add(id); rows.push(row);
    }
    // Every page before the last holds a record, so the source's own total also bounds the pages read.
    if (rows.length > expectedCount) throw new Error('Source returned more records than its total; retry with a quiet source.');
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
  }
  if (rows.length !== expectedCount) throw new Error('Export count does not match the source total; no memories were written.');
  return rows;
}

export function planImport(rows: Row[], options: ImportOptions, now = Date.now()): ImportPlan {
  validateImportOptions(options); const notes: ImportNote[] = []; const ids = new Set<string>(); let skipped = 0;
  let memoriesWithUnreadableExpirationDate = 0;
  if (options.maxRecords !== undefined && rows.length > options.maxRecords) throw new Error('Source exceeds --max-records.');
  for (const row of rows) {
    const id = required(row.id, 'Source record ID');
    if (ids.has(id)) throw new Error('Duplicate source record ID.'); ids.add(id);
    if (options.provider === 'mem0') {
      if (row.user_id !== undefined && row.user_id !== null && row.user_id !== options.scope) throw new Error('Mem0 returned a different user.');
      if (row.lifecycle_state != null && !['active', 'merged', 'superseded'].includes(row.lifecycle_state as string)) throw new Error('Unrecognized Mem0 lifecycle state.');
      if (row.replaced_by || row.replacement_memory_id || ['merged', 'superseded'].includes(row.lifecycle_state as string)) { skipped++; continue; }
      const hasExpirationDate = row.expiration_date !== undefined && row.expiration_date !== null;
      const hiddenFrom = hasExpirationDate ? mem0HiddenFrom(row.expiration_date) : null;
      if (hiddenFrom !== null && now >= hiddenFrom) { skipped++; continue; }
      // Imported as never expiring, as Mem0 treats it; the summary counts these.
      if (hasExpirationDate && hiddenFrom === null) memoriesWithUnreadableExpirationDate++;
    } else if (!options.documents) {
      if (typeof row.isForgotten !== 'boolean' || typeof row.isLatest !== 'boolean') throw new Error('Missing Supermemory lifecycle flags.');
      if (row.isForgotten || !row.isLatest) { skipped++; continue; }
    } else if (object(row.system).status !== 'done') { throw new Error('A source document is not ready; wait for processing to finish.'); }
    const text = required(row[options.documents ? 'content' : 'memory'], 'Source text');
    const kind = options.documents ? 'document' : 'memory';
    // Raw source metadata is nested, never promoted into worker control fields.
    const source = { provider: options.provider, account: options.account, scope: options.scope, kind, id, record: row };
    // Memory rows keep the whole-row fingerprint 15.19.0 saved, so an exact repeat after
    // upgrading still matches. A document's row also carries fields Supermemory changes by
    // itself (https://supermemory.ai/docs/v5/api-reference/content-management/list-resources.md):
    // `system` is "Processing status, lifecycle timestamps, and storage path maintained by
    // Supermemory"; `system.memoryCount` is "Number of live memories linked to this document
    // in the requested namespace"; `system.dreamingStatus` is "Memory generation state,
    // separate from status", and "Under dynamic dreaming, status can reach done minutes before
    // dreamingStatus does." Documents have no revision or version field (memories have
    // `version`, "Version number within the memory chain"), and `system.updatedAt` is one of
    // those maintained lifecycle timestamps. So a document's replay identity is its published
    // text, `content`: "Last published extracted text when include.content is true". New text
    // is a new revision; anything else is the same document. The full row stays in importSource.
    const revision = hash(options.documents
      ? { provider: options.provider, account: options.account, scope: options.scope, kind, id, text }
      : source);
    // Provenance lives in importSource and the fingerprint. platformSource picks the
    // host whose memory search finds the note, so it is never the vendor.
    const metadata: Row = { sourceFingerprint: `import:${options.provider}:${revision}`, importSource: source };
    // 15.19.0 fingerprinted a document by its whole row. Sending that fingerprint for the
    // worker's lookup too lets a rerun find a document 15.19.0 saved while the row is
    // unchanged; once Supermemory has changed its own fields, it no longer matches.
    if (options.documents) metadata[LOOKUP_ONLY_ALTERNATIVE_FINGERPRINT_KEY] = `import:${options.provider}:${hash(source)}`;
    if (options.platformSource !== undefined) metadata.platformSource = options.platformSource;
    // The worker also deduplicates identical title/text within its manual session.
    // The title carries the revision so records from different accounts, or memory
    // rows that differ only in metadata, cannot collapse and lose their provenance.
    const note = { text, title: `${options.provider === 'mem0' ? 'Mem0' : 'Supermemory'} ${kind} ${id} (${revision})`, project: options.project, metadata };
    // Two size limits, both checked before any write. In each, the text counts twice: once
    // as the memory and once inside the kept source record.
    // The worker refuses a larger save request (HTTP 413).
    const bytes = Buffer.byteLength(saveRequestBody(note, options.cwd));
    if (bytes > WORKER_JSON_BODY_LIMIT_BYTES) throw new Error(`Source record ${id} needs a ${bytes}-byte save request; the worker accepts at most ${WORKER_JSON_BODY_LIMIT_BYTES} bytes. Split it at the source; no memories were written.`);
    // Cloud sync refuses a larger record, so the memory would never reach cmem.ai or another
    // device. 15.19.0's 100,000-character cap happened to keep ASCII text within it.
    const syncBytes = Buffer.byteLength(JSON.stringify(observationSyncBodyBound(note)));
    if (syncBytes > CONTENT_BODY_MAX_BYTES) throw new Error(`Source record ${id} is too large to sync: as a synced record it can take up to ${syncBytes} bytes, and cloud sync refuses any record over ${CONTENT_BODY_MAX_BYTES} bytes, so it would never reach cmem.ai or your other devices. Split it at the source; no memories were written.`);
    notes.push(note);
  }
  return { notes, scanned: rows.length, skipped, memoriesWithUnreadableExpirationDate };
}

export async function applyImport(plan: ImportPlan, save: (note: ImportNote) => Promise<unknown>): Promise<{ imported: number; existing: number }> {
  let imported = 0; let existing = 0;
  const stopped = (detail: string) => new Error(`Import stopped after ${imported} new and ${existing} existing memories. ${detail}`);
  for (const note of plan.notes) {
    let result: Row;
    try { result = object(await save(note)); }
    catch (error) {
      const message = error instanceof Error ? error.message : 'Save failed.';
      throw stopped(message === 'HTTP 413' ? SAVE_REQUEST_TOO_LARGE : `${message} ${RESUME}`);
    }
    if (result.success === false && isMemorySaveRefusalReason(result.reason)) throw stopped(SAVE_REFUSALS[result.reason]);
    const expectedProject = isAbsoluteFilesystemPath(note.project) ? normalizeExplicitProject(note.project) : note.project;
    if (result.success !== true || !Number.isSafeInteger(result.id) || (result.id as number) <= 0 || result.project !== expectedProject) {
      throw stopped(`Worker did not confirm the saved memory in the selected project. ${RESUME}`);
    }
    if (result.duplicate === true) existing++; else imported++;
  }
  return { imported, existing };
}

/** `fetcher` carries every request, to the source and to the worker; tests pass a fake one. */
export async function runImportCommand(args: string[], fetcher: typeof fetch = fetch): Promise<void> {
  const { values } = parseArgs({ args, options: {
    from: { type: 'string' }, 'source-account': { type: 'string' }, user: { type: 'string' }, namespace: { type: 'string' },
    project: { type: 'string' }, documents: { type: 'boolean' }, 'dry-run': { type: 'boolean' },
    'max-records': { type: 'string' }, 'timeout-ms': { type: 'string' }, platform: { type: 'string' },
  }, strict: true, allowPositionals: false });
  if (values.from === 'mem0' && values.namespace || values.from === 'supermemory' && values.user) throw new Error('Use --user for Mem0 or --namespace for Supermemory.');
  const options: ImportOptions = { provider: values.from as ImportProvider, account: values['source-account']!,
    scope: (values.from === 'mem0' ? values.user : values.namespace)!, project: values.project!, documents: values.documents,
    maxRecords: values['max-records'] === undefined ? undefined : Number(values['max-records']),
    timeoutMs: values['timeout-ms'] === undefined ? undefined : Number(values['timeout-ms']),
    platformSource: values.platform, cwd: process.cwd(),
  };
  validateImportOptions(options);
  const keyName = options.provider === 'mem0' ? 'MEM0_API_KEY' : 'SUPERMEMORY_API_KEY';
  const apiKey = required(process.env[keyName], keyName);
  let save: ((note: ImportNote) => Promise<unknown>) | undefined;
  if (!values['dry-run']) {
    // Validate the destination before any source request if we are writing. A preview
    // needs only the source, so it neither reads worker settings nor authenticates to it.
    const base = getWorkerBaseUrl({ readOnly: true });
    const init = withWorkerAuth({ method: 'POST', headers: { 'Content-Type': 'application/json' } }, { readOnly: true });
    // The flag covers saves too. Without it use the shared worker API deadline.
    const saveTimeoutMs = options.timeoutMs ?? getWorkerApiRequestTimeoutMs({ readOnly: true });
    save = note => requestJson(`${base}/api/memory/save`, {
      ...init, body: saveRequestBody(note, options.cwd),
    }, saveTimeoutMs, fetcher);
  }
  const kind = options.documents ? 'documents' : 'memories';
  console.log(`Reading ${options.provider} ${kind}…`);
  const rows = await collectImportRows(options, apiKey, fetcher, total => console.log(`The source reports ${total} ${kind}; every page is read before anything is written.`));
  const plan = planImport(rows, options);
  console.log(`${plan.scanned} read; ${plan.skipped} skipped; ${plan.notes.length} ready to import.`);
  const unreadable = plan.memoriesWithUnreadableExpirationDate;
  if (unreadable > 0) {
    console.log(unreadable === 1
      ? '1 memory has an expiration date Mem0 cannot read; Mem0 treats it as never expiring, so it is imported that way.'
      : `${unreadable} memories have an expiration date Mem0 cannot read; Mem0 treats them as never expiring, so they are imported that way.`);
  }
  if (!save) { console.log('Dry run complete. No memories were written.'); return; }
  const result = await applyImport(plan, save);
  console.log(`Import complete: ${result.imported} new, ${result.existing} already imported, ${plan.skipped} skipped.`);
}
