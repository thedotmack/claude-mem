import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ParsedObservation } from '../../sdk/parser.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { DATA_DIR, USER_SETTINGS_PATH, ensureDir } from '../../shared/paths.js';
import { shouldEmitProjectRow } from '../../shared/should-track-project.js';
import { parseRetryAfterMs } from '../worker/retry.js';
import { logger } from '../../utils/logger.js';

export const NOTION_API_BASE = 'https://api.notion.com/v1';
export const NOTION_API_VERSION = '2022-06-28';

/** Notion's documented average limit is 3 requests per second per integration (1000ms / 3, rounded up). */
export const NOTION_MIN_REQUEST_INTERVAL_MS = 334;
/**
 * Per-request timeout. Notion documents no response-time bound; this only keeps
 * one hung socket from stalling the queue forever. A timeout is retried like a
 * network error, so a slow but working Notion still gets the write.
 */
export const NOTION_REQUEST_TIMEOUT_MS = 15_000;
/**
 * Retries per observation for 409/429/5xx/network errors. With the backoff
 * below, 5 retries wait 1+2+4+8+16 = 31s in total, enough to ride out a short
 * outage or rate-limit window; past that the item is logged as skipped so one
 * observation can't hold up the queue.
 */
export const NOTION_MAX_RETRIES = 5;
/** First retry wait, doubled each attempt. Notion's rate-limit guidance is to back off and retry. */
export const NOTION_BASE_BACKOFF_MS = 1_000;
/** Ceiling on a single backoff wait, so the queue never sleeps more than a minute between tries. */
export const NOTION_MAX_BACKOFF_MS = 60_000;
/**
 * A 429's Retry-After is honored up to this and clamped past it, so a bogus or
 * huge header can't park the single drain loop (and every queued item) for hours.
 */
export const NOTION_MAX_RETRY_AFTER_MS = 5 * 60_000;
/**
 * Memory bound while Notion is down or slow. One observation costs about two
 * requests (query + create), so at ~3 req/s 1,000 items is roughly 11 minutes
 * of backlog. Past that the oldest is dropped and each drop is logged as an error.
 */
export const NOTION_MAX_QUEUE = 1_000;

/** Notion API limit: each rich_text text object holds at most 2000 characters. */
const RICH_TEXT_CHUNK = 2_000;
/** Notion API limit: rich_text, multi_select and block children arrays hold at most 100 entries. */
const MAX_ARRAY_ENTRIES = 100;
/** Notion API limit: select and multi_select option names are at most 100 characters, no commas. */
const MAX_OPTION_NAME = 100;

/**
 * The database properties the exporter writes, besides the database's own
 * title property (whatever it is named). Missing ones are created on first
 * run when CLAUDE_MEM_NOTION_AUTO_CREATE_PROPERTIES is on; a property that
 * exists with a different type is left alone and skipped.
 */
export const NOTION_PROPERTIES = {
  /**
   * `<source id>:<observation id>`, the dedupe key. Observation IDs are local
   * SQLite row ids, so two computers exporting into one database both have an
   * observation 42; the per-install source id keeps their pages apart.
   */
  exportKey: { name: 'Export Key', type: 'rich_text' },
  observationId: { name: 'Observation ID', type: 'number' },
  type: { name: 'Type', type: 'select' },
  project: { name: 'Project', type: 'select' },
  subtitle: { name: 'Subtitle', type: 'rich_text' },
  concepts: { name: 'Concepts', type: 'multi_select' },
  filesRead: { name: 'Files Read', type: 'rich_text' },
  filesModified: { name: 'Files Modified', type: 'rich_text' },
  created: { name: 'Created', type: 'date' },
  sessionId: { name: 'Session ID', type: 'rich_text' },
} as const;

export type NotionFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface NotionObservationRecord {
  observationId: number;
  observation: ParsedObservation;
  project: string;
  memorySessionId: string;
  createdAtEpoch: number;
}

export interface NotionExporterOptions {
  token: string;
  databaseId: string;
  /**
   * Identifies this install in the Export Key. A function is resolved on the
   * first upsert, so nothing is written to disk until Notion is actually called.
   */
  sourceId: string | (() => string);
  autoCreateProperties?: boolean;
  fetchImpl?: NotionFetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  minRequestIntervalMs?: number;
  maxRetries?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  maxQueue?: number;
}

export class NotionHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    readonly notionMessage: string | undefined,
    readonly retryAfterMs?: number,
  ) {
    super(`Notion API responded ${status}${code ? ` (${code})` : ''}`);
    this.name = 'NotionHttpError';
  }
}

/** Accepts a bare id (dashed or not) or a Notion database URL; returns the dashed UUID, or null. */
export function normalizeNotionId(value: string): string | null {
  const path = value.trim().split(/[?#]/)[0].replace(/\/+$/, '').replace(/-/g, '');
  const match = path.match(/([0-9a-f]{32})$/i);
  if (!match) return null;
  const hex = match[1].toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function chunkText(text: string, size = RICH_TEXT_CHUNK): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

type RichText = Array<{ type: 'text'; text: { content: string } }>;

function toRichText(chunks: string[]): RichText {
  return chunks.map(content => ({ type: 'text', text: { content } }));
}

/**
 * A property value's rich_text. Notion takes at most 100 x 2000 characters per
 * property; longer text is cut there and the cut is logged. Page body text is
 * never cut: it is split across blocks instead.
 */
function richText(text: string, property: string, observationId: number): RichText {
  const chunks = chunkText(text);
  if (chunks.length > MAX_ARRAY_ENTRIES) {
    logger.warn('NOTION', 'Notion property text is longer than Notion allows, truncating it', {
      property,
      observationId,
      characters: text.length,
      keptCharacters: MAX_ARRAY_ENTRIES * RICH_TEXT_CHUNK,
    });
  }
  return toRichText(chunks.slice(0, MAX_ARRAY_ENTRIES));
}

function optionName(value: string): string {
  return value.replace(/,/g, ' ').trim().slice(0, MAX_OPTION_NAME);
}

export function notionExportKey(sourceId: string, observationId: number): string {
  return `${sourceId}:${observationId}`;
}

/**
 * Property values for one observation, keyed by property name. The title goes
 * under `titleProperty` and is written last: if the database's title column
 * shares a name with an exporter property (say it is called "Project"), the
 * title wins and that exporter property is left out.
 */
export function buildNotionProperties(record: NotionObservationRecord, titleProperty: string, sourceId: string): Record<string, unknown> {
  const { observation, observationId } = record;
  const title = observation.title?.trim() || observation.subtitle?.trim() || `Observation #${observationId}`;
  const p = NOTION_PROPERTIES;
  const concepts = [...new Set(observation.concepts.map(optionName).filter(Boolean))];
  if (concepts.length > MAX_ARRAY_ENTRIES) {
    logger.warn('NOTION', 'Observation has more concepts than Notion allows, exporting the first 100', {
      observationId,
      concepts: concepts.length,
    });
  }
  return {
    [p.exportKey.name]: { rich_text: richText(notionExportKey(sourceId, observationId), p.exportKey.name, observationId) },
    [p.observationId.name]: { number: observationId },
    [p.type.name]: { select: optionName(observation.type) ? { name: optionName(observation.type) } : null },
    [p.project.name]: { select: optionName(record.project) ? { name: optionName(record.project) } : null },
    [p.subtitle.name]: { rich_text: richText(observation.subtitle ?? '', p.subtitle.name, observationId) },
    [p.concepts.name]: { multi_select: concepts.slice(0, MAX_ARRAY_ENTRIES).map(name => ({ name })) },
    [p.filesRead.name]: { rich_text: richText(observation.files_read.join('\n'), p.filesRead.name, observationId) },
    [p.filesModified.name]: { rich_text: richText(observation.files_modified.join('\n'), p.filesModified.name, observationId) },
    [p.created.name]: { date: { start: new Date(record.createdAtEpoch).toISOString() } },
    [p.sessionId.name]: { rich_text: richText(record.memorySessionId, p.sessionId.name, observationId) },
    [titleProperty]: { title: richText(title, titleProperty, observationId) },
  };
}

/** One block per 100 text chunks, so a very long paragraph spans several blocks instead of being cut. */
function textBlocks(type: 'paragraph' | 'bulleted_list_item', text: string): unknown[] {
  const chunks = chunkText(text);
  const blocks: unknown[] = [];
  for (let i = 0; i < chunks.length; i += MAX_ARRAY_ENTRIES) {
    blocks.push({ object: 'block', type, [type]: { rich_text: toRichText(chunks.slice(i, i + MAX_ARRAY_ENTRIES)) } });
  }
  return blocks;
}

/**
 * Page body: the narrative as paragraphs, then the facts as a bulleted list.
 * Returns every block; the exporter sends them 100 at a time (Notion's
 * children-array limit), so a long note arrives whole.
 */
export function buildNotionChildren(observation: ParsedObservation): unknown[] {
  const blocks: unknown[] = [];
  const narrative = observation.narrative?.trim();
  if (narrative) {
    for (const paragraph of narrative.split(/\n{2,}/)) {
      if (paragraph.trim()) blocks.push(...textBlocks('paragraph', paragraph.trim()));
    }
  }
  const facts = observation.facts.map(fact => fact.trim()).filter(Boolean);
  if (facts.length > 0) {
    blocks.push({ object: 'block', type: 'heading_3', heading_3: { rich_text: toRichText(['Facts']) } });
    for (const fact of facts) blocks.push(...textBlocks('bulleted_list_item', fact));
  }
  return blocks;
}

function isRetryableStatus(status: number): boolean {
  // 409 conflict_error is Notion's "transaction conflict, retry" signal.
  return status === 409 || status === 429 || status >= 500;
}

/** A log-safe reason: HTTP status and Notion's error code/message, never the request (it carries the token). */
export function notionFailureReason(error: unknown): string {
  if (error instanceof NotionHttpError) {
    const detail = error.notionMessage ? `: ${error.notionMessage.slice(0, 200)}` : '';
    return `HTTP ${error.status}${error.code ? ` ${error.code}` : ''}${detail}`;
  }
  if (!(error instanceof Error)) return 'unknown error';
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return `timed out after ${NOTION_REQUEST_TIMEOUT_MS}ms`;
  const code = (error as { code?: unknown }).code ?? (error.cause as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' && /^[A-Za-z0-9_]+$/.test(code) ? `${error.name} (${code})` : error.name;
}

interface DatabaseSchema {
  titleProperty: string;
  /** Exporter property names that exist with the expected type. */
  writable: Set<string>;
}

/**
 * Pushes observations to one Notion database. `enqueue` never blocks and never
 * throws; a single drain loop works the queue in order, throttled to
 * ~3 req/s, retrying 409/429/5xx/network failures with exponential backoff
 * (a 429's Retry-After wins over the backoff). Each observation is written
 * once, keyed by its "Export Key" property: query, and create the page only if
 * none holds that key. An existing page is left alone, matching SQLite, where
 * the first stored copy wins over a replay of the same observation.
 * Failures are logged and the item dropped; capture never waits on Notion.
 */
export class NotionExporter {
  readonly databaseId: string;
  private readonly token: string;
  private sourceId: string | (() => string);
  private readonly autoCreateProperties: boolean;
  private readonly fetchImpl: NotionFetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly minRequestIntervalMs: number;
  private readonly maxRetries: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxQueue: number;

  private readonly queue: NotionObservationRecord[] = [];
  private draining: Promise<void> | null = null;
  private lastRequestAt = Number.NEGATIVE_INFINITY;
  private schema: DatabaseSchema | null = null;
  /** Set on 401/403/404: the token or database is wrong, so stop calling until settings change. */
  private disabledReason: string | null = null;

  constructor(options: NotionExporterOptions) {
    this.token = options.token;
    this.sourceId = options.sourceId;
    this.databaseId = options.databaseId;
    this.autoCreateProperties = options.autoCreateProperties ?? true;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
    this.minRequestIntervalMs = options.minRequestIntervalMs ?? NOTION_MIN_REQUEST_INTERVAL_MS;
    this.maxRetries = options.maxRetries ?? NOTION_MAX_RETRIES;
    this.baseBackoffMs = options.baseBackoffMs ?? NOTION_BASE_BACKOFF_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? NOTION_MAX_BACKOFF_MS;
    this.maxQueue = options.maxQueue ?? NOTION_MAX_QUEUE;
  }

  get pending(): number {
    return this.queue.length;
  }

  enqueue(record: NotionObservationRecord): void {
    if (this.disabledReason) {
      logger.warn('NOTION', 'Notion export is disabled after an auth or not-found error, observation not exported', {
        observationId: record.observationId,
        reason: this.disabledReason,
      });
      return;
    }
    this.queue.push(record);
    if (this.queue.length > this.maxQueue) {
      const dropped = this.queue.shift();
      logger.error('NOTION', 'Notion export queue full, dropping oldest observation', {
        observationId: dropped?.observationId,
        maxQueue: this.maxQueue,
      });
    }
    if (!this.draining) {
      this.draining = this.drain().finally(() => {
        this.draining = null;
      });
    }
  }

  /** Resolves once the queue is empty. For tests and shutdown. */
  async idle(): Promise<void> {
    while (this.draining) await this.draining;
  }

  private async drain(): Promise<void> {
    let record: NotionObservationRecord | undefined;
    while ((record = this.queue.shift())) {
      if (this.disabledReason) {
        this.queue.length = 0;
        return;
      }
      try {
        await this.upsertWithRetry(record);
      } catch (error) {
        const reason = notionFailureReason(error);
        if (error instanceof NotionHttpError && [401, 403, 404].includes(error.status)) {
          this.disabledReason = reason;
          const droppedObservationIds = [record.observationId, ...this.queue.map(queued => queued.observationId)];
          this.queue.length = 0;
          logger.error('NOTION', 'Notion export disabled until settings change: check the token and that the database is shared with the integration', {
            databaseId: this.databaseId,
            reason,
            droppedObservationIds,
          });
          return;
        }
        logger.error('NOTION', 'Notion export failed, observation skipped', {
          observationId: record.observationId,
          project: record.project,
          reason,
        });
      }
    }
  }

  private resolveSourceId(): string {
    if (typeof this.sourceId === 'function') this.sourceId = this.sourceId();
    return this.sourceId;
  }

  async upsert(record: NotionObservationRecord): Promise<'created' | 'exists'> {
    const schema = await this.ensureSchema();
    const sourceId = this.resolveSourceId();
    const allProperties = buildNotionProperties(record, schema.titleProperty, sourceId);
    const properties = Object.fromEntries(
      Object.entries(allProperties).filter(([name]) => name === schema.titleProperty || schema.writable.has(name)),
    );

    if (schema.writable.has(NOTION_PROPERTIES.exportKey.name)) {
      if (await this.findPageId(notionExportKey(sourceId, record.observationId))) return 'exists';
    }

    const children = buildNotionChildren(record.observation);
    const page = await this.request('POST', '/pages', {
      parent: { database_id: this.databaseId },
      properties,
      children: children.slice(0, MAX_ARRAY_ENTRIES),
    }) as { id?: string };
    if (children.length > MAX_ARRAY_ENTRIES) await this.appendRemainingChildren(record, page.id, children);
    return 'created';
  }

  /**
   * Notion takes at most 100 children per request, so the rest of a long body
   * is appended to the new page 100 blocks at a time. Each batch gets the same
   * retries as an upsert (a whole-upsert retry would find the page by its
   * Export Key and stop, so the retry has to happen here). A batch that still
   * fails is logged with how much of the body is missing. A batch that timed
   * out but landed can be appended twice; a repeated block beats a missing one.
   */
  private async appendRemainingChildren(record: NotionObservationRecord, pageId: string | undefined, children: unknown[]): Promise<void> {
    let sent = MAX_ARRAY_ENTRIES;
    try {
      if (!pageId) throw new Error('Notion create response had no page id');
      for (; sent < children.length; sent += MAX_ARRAY_ENTRIES) {
        const batch = children.slice(sent, sent + MAX_ARRAY_ENTRIES);
        await this.withRetry(() => this.request('PATCH', `/blocks/${pageId}/children`, { children: batch }));
      }
    } catch (error) {
      logger.error('NOTION', 'Notion page created, but the rest of its body could not be appended', {
        observationId: record.observationId,
        blocksSent: sent,
        blocksTotal: children.length,
        reason: notionFailureReason(error),
      });
    }
  }

  private async findPageId(exportKey: string): Promise<string | null> {
    const result = await this.request('POST', `/databases/${this.databaseId}/query`, {
      filter: { property: NOTION_PROPERTIES.exportKey.name, rich_text: { equals: exportKey } },
      page_size: 1,
    }) as { results?: Array<{ id?: string }> };
    return result.results?.[0]?.id ?? null;
  }

  private async ensureSchema(): Promise<DatabaseSchema> {
    if (this.schema) return this.schema;

    const database = await this.request('GET', `/databases/${this.databaseId}`) as {
      properties?: Record<string, { type?: string }>;
    };
    const existing = database.properties ?? {};
    const titleProperty = Object.entries(existing).find(([, property]) => property.type === 'title')?.[0] ?? 'Name';

    const writable = new Set<string>();
    const missing: Record<string, Record<string, object>> = {};
    for (const { name, type } of Object.values(NOTION_PROPERTIES)) {
      const current = existing[name];
      if (!current) {
        missing[name] = { [type]: {} };
      } else if (current.type === type) {
        writable.add(name);
      } else {
        logger.error('NOTION', 'Notion database property has an unexpected type, skipping it', {
          property: name,
          expected: type,
          actual: current.type,
        });
      }
    }

    const missingNames = Object.keys(missing);
    if (missingNames.length > 0) {
      if (this.autoCreateProperties) {
        await this.request('PATCH', `/databases/${this.databaseId}`, { properties: missing });
        for (const name of missingNames) writable.add(name);
      } else {
        logger.error('NOTION', 'Notion database is missing properties; exporting without them', {
          missing: missingNames,
        });
      }
    }

    this.schema = { titleProperty, writable };
    return this.schema;
  }

  /**
   * Retries wrap the whole upsert, not single calls: a create that timed out
   * but landed is found by the next attempt's query instead of duplicated.
   */
  private async upsertWithRetry(record: NotionObservationRecord): Promise<void> {
    await this.withRetry(() => this.upsert(record));
  }

  /** Runs `operation`, retrying 409/429/5xx/network failures with backoff; rethrows anything else or the last failure. */
  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await operation();
      } catch (error) {
        if (error instanceof NotionHttpError && !isRetryableStatus(error.status)) throw error;
        if (attempt >= this.maxRetries) throw error;
        const backoffMs = Math.min(this.baseBackoffMs * 2 ** attempt, this.maxBackoffMs);
        const retryAfterMs = error instanceof NotionHttpError ? error.retryAfterMs : undefined;
        await this.sleep(retryAfterMs !== undefined ? Math.min(retryAfterMs, NOTION_MAX_RETRY_AFTER_MS) : backoffMs);
      }
    }
  }

  /** One throttled API call. Returns the parsed JSON body; throws NotionHttpError on a non-2xx. */
  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const waitMs = this.lastRequestAt + this.minRequestIntervalMs - this.now();
    if (waitMs > 0) await this.sleep(waitMs);
    this.lastRequestAt = this.now();

    const response = await this.fetchImpl(`${NOTION_API_BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        'notion-version': NOTION_API_VERSION,
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(NOTION_REQUEST_TIMEOUT_MS),
    });
    if (response.ok) return await response.json();

    const errorBody = await response.json().catch(() => ({})) as { code?: string; message?: string };
    const retryAfterMs = response.status === 429 ? parseRetryAfterMs(response.headers.get('retry-after')) : undefined;
    throw new NotionHttpError(response.status, errorBody.code, errorBody.message, retryAfterMs);
  }
}

/**
 * A random id for this install, kept in the data dir so it survives restarts.
 * It only tells this computer's pages apart from another's in a shared
 * database; it is not a secret and is not tied to any account.
 */
export function loadOrCreateNotionSourceId(path = join(DATA_DIR, 'notion-export-source-id')): string {
  try {
    const existing = readFileSync(path, 'utf8').trim();
    if (existing) return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const created = randomUUID();
  ensureDir(dirname(path));
  try {
    writeFileSync(path, `${created}\n`, { flag: 'wx' });
    return created;
  } catch (error) {
    // Another worker created it first: use that one.
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return readFileSync(path, 'utf8').trim();
    throw error;
  }
}

let shared: { key: string; exporter: NotionExporter } | null = null;

/** The exporter for the current settings, or null when disabled or misconfigured. */
export function getNotionExporter(settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH)): NotionExporter | null {
  if (settings.CLAUDE_MEM_NOTION_ENABLED !== 'true') return null;
  const token = (settings.CLAUDE_MEM_NOTION_TOKEN ?? '').trim();
  const databaseId = normalizeNotionId(settings.CLAUDE_MEM_NOTION_DATABASE_ID ?? '');
  if (!token || !databaseId) return null;
  const autoCreateProperties = settings.CLAUDE_MEM_NOTION_AUTO_CREATE_PROPERTIES !== 'false';

  const key = JSON.stringify([token, databaseId, autoCreateProperties]);
  if (shared?.key !== key) {
    shared = {
      key,
      exporter: new NotionExporter({ token, databaseId, autoCreateProperties, sourceId: () => loadOrCreateNotionSourceId() }),
    };
  }
  return shared.exporter;
}

/** Test hook: forget the cached exporter. */
export function resetNotionExporterForTests(): void {
  shared = null;
}

export interface NotionNotifyInput {
  observations: ParsedObservation[];
  observationIds: number[];
  project: string;
  memorySessionId: string;
  createdAtEpoch: number;
}

/**
 * Queue freshly stored observations for Notion. Off unless
 * CLAUDE_MEM_NOTION_ENABLED is true and the token and database id are set.
 * Returns immediately; never throws.
 */
export function notifyNotion(input: NotionNotifyInput): void {
  try {
    if (!shouldEmitProjectRow(input.project)) return;
    const exporter = getNotionExporter();
    if (!exporter) return;
    input.observations.forEach((observation, index) => {
      const observationId = input.observationIds[index];
      if (observationId === undefined) return;
      exporter.enqueue({
        observationId,
        observation,
        project: input.project,
        memorySessionId: input.memorySessionId,
        createdAtEpoch: input.createdAtEpoch,
      });
    });
  } catch (error) {
    logger.error('NOTION', 'Notion export could not be queued', { project: input.project }, error as Error);
  }
}
