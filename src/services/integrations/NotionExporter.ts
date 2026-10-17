import { ParsedObservation } from '../../sdk/parser.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { shouldEmitProjectRow } from '../../shared/should-track-project.js';
import { parseRetryAfterMs } from '../worker/retry.js';
import { logger } from '../../utils/logger.js';

export const NOTION_API_BASE = 'https://api.notion.com/v1';
export const NOTION_API_VERSION = '2022-06-28';

/** Notion's documented average limit is 3 requests per second per integration. */
export const NOTION_MIN_REQUEST_INTERVAL_MS = 334;
export const NOTION_REQUEST_TIMEOUT_MS = 15_000;
export const NOTION_MAX_RETRIES = 5;
export const NOTION_BASE_BACKOFF_MS = 1_000;
export const NOTION_MAX_BACKOFF_MS = 60_000;
/** A Retry-After longer than this is clamped; the item still waits it out. */
export const NOTION_MAX_RETRY_AFTER_MS = 5 * 60_000;
/** Oldest entries are dropped past this, so a dead Notion can't grow memory without bound. */
export const NOTION_MAX_QUEUE = 1_000;

/** Notion caps each rich_text text object at 2000 characters. */
const RICH_TEXT_CHUNK = 2_000;
/** Notion caps rich_text arrays and children arrays at 100 entries. */
const MAX_ARRAY_ENTRIES = 100;
/** Select and multi_select option names: at most 100 characters, no commas. */
const MAX_OPTION_NAME = 100;

/**
 * The database properties the exporter writes, besides the database's own
 * title property (whatever it is named). Missing ones are created on first
 * run when CLAUDE_MEM_NOTION_AUTO_CREATE_PROPERTIES is on; a property that
 * exists with a different type is left alone and skipped.
 */
export const NOTION_PROPERTIES = {
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
  for (let i = 0; i < text.length && chunks.length < MAX_ARRAY_ENTRIES; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

function richText(text: string): Array<{ type: 'text'; text: { content: string } }> {
  return chunkText(text).map(content => ({ type: 'text', text: { content } }));
}

function optionName(value: string): string {
  return value.replace(/,/g, ' ').trim().slice(0, MAX_OPTION_NAME);
}

/** Property values for one observation, keyed by property name. The title goes under `titleProperty`. */
export function buildNotionProperties(record: NotionObservationRecord, titleProperty: string): Record<string, unknown> {
  const { observation } = record;
  const title = observation.title?.trim() || observation.subtitle?.trim() || `Observation #${record.observationId}`;
  const p = NOTION_PROPERTIES;
  const concepts = [...new Set(observation.concepts.map(optionName).filter(Boolean))].slice(0, MAX_ARRAY_ENTRIES);
  return {
    [titleProperty]: { title: richText(title) },
    [p.observationId.name]: { number: record.observationId },
    [p.type.name]: { select: optionName(observation.type) ? { name: optionName(observation.type) } : null },
    [p.project.name]: { select: optionName(record.project) ? { name: optionName(record.project) } : null },
    [p.subtitle.name]: { rich_text: richText(observation.subtitle ?? '') },
    [p.concepts.name]: { multi_select: concepts.map(name => ({ name })) },
    [p.filesRead.name]: { rich_text: richText(observation.files_read.join('\n')) },
    [p.filesModified.name]: { rich_text: richText(observation.files_modified.join('\n')) },
    [p.created.name]: { date: { start: new Date(record.createdAtEpoch).toISOString() } },
    [p.sessionId.name]: { rich_text: richText(record.memorySessionId) },
  };
}

/** Page body: the narrative as paragraphs, then the facts as a bulleted list. */
export function buildNotionChildren(observation: ParsedObservation): unknown[] {
  const blocks: unknown[] = [];
  const narrative = observation.narrative?.trim();
  if (narrative) {
    for (const paragraph of narrative.split(/\n{2,}/)) {
      if (paragraph.trim()) {
        blocks.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: richText(paragraph.trim()) } });
      }
    }
  }
  const facts = observation.facts.map(fact => fact.trim()).filter(Boolean);
  if (facts.length > 0) {
    blocks.push({ object: 'block', type: 'heading_3', heading_3: { rich_text: richText('Facts') } });
    for (const fact of facts) {
      blocks.push({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: richText(fact) } });
    }
  }
  return blocks.slice(0, MAX_ARRAY_ENTRIES);
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
 * (a 429's Retry-After wins over the backoff). Each observation is upserted by its
 * "Observation ID" property: query, then update the page or create one.
 * Failures are logged and the item dropped; capture never waits on Notion.
 */
export class NotionExporter {
  readonly databaseId: string;
  private readonly token: string;
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
    if (this.disabledReason) return;
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
          this.queue.length = 0;
          logger.error('NOTION', 'Notion export disabled until settings change: check the token and that the database is shared with the integration', {
            databaseId: this.databaseId,
            reason,
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

  async upsert(record: NotionObservationRecord): Promise<'created' | 'updated'> {
    const schema = await this.ensureSchema();
    const allProperties = buildNotionProperties(record, schema.titleProperty);
    const properties = Object.fromEntries(
      Object.entries(allProperties).filter(([name]) => name === schema.titleProperty || schema.writable.has(name)),
    );

    const existingPageId = schema.writable.has(NOTION_PROPERTIES.observationId.name)
      ? await this.findPageId(record.observationId)
      : null;

    if (existingPageId) {
      await this.request('PATCH', `/pages/${existingPageId}`, { properties });
      return 'updated';
    }
    await this.request('POST', '/pages', {
      parent: { database_id: this.databaseId },
      properties,
      children: buildNotionChildren(record.observation),
    });
    return 'created';
  }

  private async findPageId(observationId: number): Promise<string | null> {
    const result = await this.request('POST', `/databases/${this.databaseId}/query`, {
      filter: { property: NOTION_PROPERTIES.observationId.name, number: { equals: observationId } },
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
    for (let attempt = 0; ; attempt++) {
      try {
        await this.upsert(record);
        return;
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
    shared = { key, exporter: new NotionExporter({ token, databaseId, autoCreateProperties }) };
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
