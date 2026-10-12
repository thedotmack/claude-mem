
import { ChromaMcpManager } from './ChromaMcpManager.js';
import { ChromaSyncState, ProjectWatermarks } from './ChromaSyncState.js';
import { parseStringListField } from './string-list-field.js';
import { ParsedObservation, ParsedSummary } from '../../sdk/parser.js';
// cmem-sdk: keep SessionStore + parseFileList off the SDK's import graph.
// Both come from the SQLite layer (`bun:sqlite`). The SDK never calls the
// SQLite-only methods of ChromaSync, so a TYPE-ONLY import is sufficient —
// the value-level use (parseFileList(...)) is loaded lazily inside the
// methods that need it. Plan §3 anti-pattern: do NOT add `bun:sqlite` to
// the SDK bundle externals — fix the import chain.
import type { SessionStore as SessionStoreType } from '../sqlite/SessionStore.js';
import { logger } from '../../utils/logger.js';
import { ChromaCorruptCollectionError, ChromaUnavailableError } from '../worker/search/errors.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH, paths } from '../../shared/paths.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';
import type * as SqliteFilesModule from '../sqlite/observations/files.js';
import { streamRows } from '../sqlite/stream-rows.js';

type SessionStore = SessionStoreType;

// Lazy CJS require so tsup (used by the cmem-sdk build) does not follow
// these SQLite-coupled modules into the SDK bundle. Worker/Bun runtime
// reaches them at first call; the SDK never calls the methods that
// trigger these loads, so they never load in SDK consumers.
const lazyCreateRequire = (): ((id: string) => unknown) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('module') as typeof import('module');
  return mod.createRequire(import.meta.url);
};

let _filesHelper: typeof SqliteFilesModule | undefined;
function loadFilesHelper(): typeof SqliteFilesModule {
  if (!_filesHelper) {
    const req = lazyCreateRequire();
    _filesHelper = req('../sqlite/observations/files.js') as typeof SqliteFilesModule;
  }
  return _filesHelper;
}

// Exported for cmem-sdk Phase 6: the SDK builds ChromaDocument values from
// Postgres observations (UUID id, content string, metadata bag) and calls
// the now-public addDocuments() to index them. Shape is unchanged.
export interface ChromaDocument {
  id: string;
  document: string;
  metadata: Record<string, string | number>;
}

/**
 * Why a backfill run stopped before attempting every row: the worker began
 * shutting down (local Chroma then refuses every write), Chroma refused
 * writes for MAX_CONSECUTIVE_BATCH_FAILURES rows in a row, or the collection
 * was dropped as corrupt mid-run (#3202). In the first two cases the rows stay
 * pending or above the watermark and the next run resumes from them; after a
 * drop, every project is rebuilt from zero.
 */
export type BackfillAbortReason = 'shutdown' | 'write_failures' | 'collection_dropped';

/**
 * 'completed' when a project's backfill attempted every row and every write
 * landed; 'rows_pending' when it attempted every row but some writes failed
 * (those rows stay pending and the next run retries only them); else why it
 * stopped early.
 */
export type BackfillOutcome = 'completed' | 'rows_pending' | BackfillAbortReason;

/**
 * Outcome of one backfillKind() pass (#4069). `writtenDocs` counts documents
 * that actually landed in Chroma — not rows planned — and `emptyRows` counts
 * rows with nothing to index (no title and no body), which are drained instead
 * of being reported missing on every sweep. `writeFailures` is true when some
 * row's write failed even though the pass walked every row: unlike
 * `abortReason`, it does not stop the pipeline, so the remaining kinds still
 * run and the project reports 'rows_pending' instead of 'completed' (#4264).
 */
export interface BackfillKindResult {
  writtenDocs: number;
  emptyRows: number;
  abortReason: BackfillAbortReason | null;
  writeFailures: boolean;
}

export interface MergedIntoProjectTarget {
  docType: 'observation' | 'session_summary';
  sqliteId: number;
}

interface StoredObservation {
  id: number;
  memory_session_id: string;
  project: string;
  merged_into_project: string | null;
  platform_source?: string | null;
  text: string | null;
  type: string;
  title: string | null;
  subtitle: string | null;
  facts: string | null; 
  narrative: string | null;
  concepts: string | null; 
  files_read: string | null;
  files_modified: string | null;
  prompt_number: number;
  created_at_epoch: number;
}

interface StoredSummary {
  id: number;
  memory_session_id: string;
  project: string;
  merged_into_project: string | null;
  platform_source?: string | null;
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  notes: string | null;
  prompt_number: number;
  created_at_epoch: number;
}

interface StoredUserPrompt {
  id: number;
  content_session_id: string;
  prompt_number: number;
  prompt_text: string;
  created_at_epoch: number;
  memory_session_id: string;
  project: string;
  platform_source: string;
}

/**
 * Whether the worker has begun shutting down: local Chroma then refuses every
 * mutation (see {@link ChromaMcpManager.acceptsMutations}).
 */
function shutdownBegan(): boolean {
  return !ChromaMcpManager.getInstance().acceptsMutations();
}

/**
 * Title and subtitle as one searchable text, or '' when the row has neither.
 * 'Untitled' is only the metadata placeholder for a missing title.
 */
function observationTitleText(obs: Pick<StoredObservation, 'title' | 'subtitle'>): string {
  const title = obs.title?.trim() === 'Untitled' ? '' : obs.title?.trim() ?? '';
  return [title, obs.subtitle?.trim() ?? ''].filter(part => part.length > 0).join('\n');
}

// The embedding functions the pinned chroma-mcp (0.2.6) knows. It resolves the
// name before checking whether the collection exists, so any other value would
// fail every chroma_create_collection call, and with it every write.
const CHROMA_MCP_EMBEDDING_FUNCTIONS: ReadonlySet<string> = new Set([
  'default', 'openai', 'cohere', 'jina', 'voyageai', 'roboflow',
]);

// Chroma's error for an HNSW segment that can no longer apply its write-ahead
// log (#3202). Only this proves the collection itself is broken: an
// embedding-runtime failure (onnxruntime INVALID_PROTOBUF, #2371), a protobuf
// import error or one bad metadata value also come back as a tool error, and
// dropping every project's vectors for those would be wrong.
const CORRUPT_SEGMENT_ERROR_SIGNATURE = 'Failed to apply logs to the hnsw segment writer';
// A stuck segment fails every write, a fluke does not: the signature has to
// repeat on this many distinct batches, with no successful write in between.
const CORRUPT_SEGMENT_CONFIRMING_BATCHES = 2;

/** Raw-document exhaustion for consumers that widen a filtered candidate window. */
export interface ChromaQueryProgress {
  exhausted?: boolean;
}

/** The last corrupt collection this process dropped, for health reporting. */
export interface ChromaCollectionDrop {
  collection: string;
  droppedAt: string;
  documentCount: number | null;
  error: string;
}

/**
 * Chroma brute-forces the metadata-matched candidate set instead of walking the
 * HNSW graph, so a `where` clause costs ~30-50us per MATCHED document while an
 * unfiltered query is flat regardless of n_results. Measured on a 347k-doc
 * collection: unfiltered 0.15-0.29s for n_results 100..2000, versus 6.10s for
 * `where {project: <60% of corpus>}`.
 *
 * So over-fetch unfiltered and filter here. Over-fetching is close to free;
 * pushing a non-selective filter into chroma is not.
 */
const CHROMA_OVERFETCH_FACTOR = 20;
const CHROMA_OVERFETCH_CAP = 2000;

type MetadataPredicate = (metadata: Record<string, unknown>) => boolean;

/**
 * Build a client-side equivalent of a chroma `where` clause, or null if the
 * clause uses anything we do not evaluate identically to chroma.
 *
 * Deliberately narrow: equality (a literal or `$eq`) or membership (`$in`) on
 * strings, numbers or booleans, combined with `$and` / `$or`. That covers every
 * clause the search paths build, including the dual-project scoping
 * `{ $or: [{ project }, { merged_into_project: project }] }` that scopes nearly
 * every project search, in every stored spelling of the project (an `$in` once
 * a project has more than one, #3531). Everything else returns null so the
 * query goes to chroma unchanged: other operators ($ne, $nin, ranges), and the
 * shapes chroma itself rejects (a clause with more than one key, an `$and` /
 * `$or` with fewer than two clauses, an `$in` that is empty or mixes types), so
 * an invalid filter still fails the way it did. A wrong client-side filter
 * would silently drop results, which is far worse than a slow query.
 */
function buildClientSidePredicate(where: unknown): MetadataPredicate | null {
  if (!where || typeof where !== 'object' || Array.isArray(where)) return null;

  const entries = Object.entries(where);
  if (entries.length !== 1) return null;
  const [key, value] = entries[0];

  if (key === '$and' || key === '$or') {
    if (!Array.isArray(value) || value.length < 2) return null;
    const clauses = value.map(clause => buildClientSidePredicate(clause));
    if (clauses.some(clause => clause === null)) return null;
    const predicates = clauses as MetadataPredicate[];
    return key === '$and'
      ? metadata => predicates.every(predicate => predicate(metadata))
      : metadata => predicates.some(predicate => predicate(metadata));
  }
  if (key.startsWith('$')) return null;

  const isOperatorObject = value !== null && typeof value === 'object' && !Array.isArray(value);
  if (isOperatorObject && Object.keys(value).length === 1 && '$in' in value) {
    const allowed = (value as { $in: unknown }).$in;
    if (
      !Array.isArray(allowed) ||
      allowed.length === 0 ||
      !allowed.every(candidate => isMetadataScalar(candidate) && typeof candidate === typeof allowed[0])
    ) {
      return null;
    }
    // A document without the key never matches, exactly as in chroma.
    return metadata => allowed.includes(metadata[key]);
  }
  const expected = isOperatorObject && Object.keys(value).length === 1 && '$eq' in value
    ? (value as { $eq: unknown }).$eq
    : value;
  if (!isMetadataScalar(expected)) {
    return null;
  }
  // A document without the key never matches, exactly as in chroma.
  return metadata => metadata[key] === expected;
}

function isMetadataScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

export class ChromaSync {
  private project: string;
  private collectionName: string;
  private collectionEnsuredGeneration = -1;
  /**
   * Where-clauses observed to be selective, keyed by clause signature.
   *
   * The over-fetch fast path is a net loss for a selective filter: it pays the
   * unfiltered fetch AND the filtered query it was trying to avoid. One miss is
   * enough to learn that, after which we go straight to chroma -- which is cheap
   * for exactly these filters. Bounded so it cannot grow without limit.
   */
  private selectiveFilters = new Map<string, number>();
  private static readonly SELECTIVE_FILTER_MEMO_CAP = 256;
  private collectionCreation: Promise<void> | null = null;
  private readonly BATCH_SIZE = 100;
  // How many rows in a row may fail to write before a backfill run gives up
  // (#3928). Set per run in ensureBackfilled and read by runBackfillPipeline.
  private readonly MAX_CONSECUTIVE_BATCH_FAILURES = 3;

  /**
   * Bumped when a corrupt collection is dropped. It invalidates every
   * instance's ensure-collection cache at once, so nothing writes into the
   * deleted collection, and stops backfill runs that were writing into it.
   */
  private static collectionGeneration = 0;

  /**
   * Registered at worker startup so a drop outside a backfill sweep (a live
   * write tripping it) can start the rebuild right away.
   */
  private static backfillStore: SessionStore | null = null;

  /**
   * First document id of each distinct batch that failed with the corrupt
   * segment signature since the collection's last successful write.
   */
  private static corruptSegmentBatches = new Map<string, Set<string>>();

  /**
   * Collections dropped once already in this process. If the rebuilt
   * collection fails the same way, Chroma itself is broken: report it rather
   * than drop and rebuild in a loop.
   */
  private static droppedCollections = new Set<string>();

  /**
   * Drop attempts whose delete call rejected, per collection, in this process.
   * A rejection can follow a delete that committed (a request deadline) or a
   * delete that never reached chroma-mcp (no connection yet), so a few are
   * retried. Each one restarts the backfill sweep; once the budget is spent the
   * collection counts as dropped, so a delete that keeps failing cannot loop.
   */
  private static failedDropAttempts = new Map<string, number>();
  private static readonly MAX_FAILED_DROP_ATTEMPTS = 3;

  private static lastCollectionDrop: ChromaCollectionDrop | null = null;

  constructor(project: string) {
    this.project = project;
    const sanitized = project
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .replace(/[^a-zA-Z0-9]+$/, '');  
    this.collectionName = `cm__${sanitized || 'unknown'}`;
  }

  /** Public: cmem-sdk reuses the per-tenant collection name for raw queries. */
  public getCollectionName(): string {
    return this.collectionName;
  }

  static registerBackfillStore(store: SessionStore): void {
    ChromaSync.backfillStore = store;
  }

  /** The last corrupt collection this process dropped, or null. */
  static getLastCollectionDrop(): ChromaCollectionDrop | null {
    return ChromaSync.lastCollectionDrop;
  }

  // Public: cmem-sdk requires Chroma at construction. Plan §3 line 192.
  public async ensureCollectionExists(): Promise<void> {
    if (this.collectionEnsuredGeneration === ChromaSync.collectionGeneration) {
      return;
    }

    if (!this.collectionCreation) {
      this.collectionCreation = this.createCollection().finally(() => {
        this.collectionCreation = null;
      });
    }
    await this.collectionCreation;
  }

  private async createCollection(): Promise<void> {
    const chromaMcp = ChromaMcpManager.getInstance();
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const embeddingFunction =
      settings.CLAUDE_MEM_CHROMA_EMBEDDING_FUNCTION || 'default';
    if (!CHROMA_MCP_EMBEDDING_FUNCTIONS.has(embeddingFunction)) {
      throw new Error(
        `CLAUDE_MEM_CHROMA_EMBEDDING_FUNCTION="${embeddingFunction}" is not an embedding function chroma-mcp supports ` +
        `(${[...CHROMA_MCP_EMBEDDING_FUNCTIONS].join(', ')})`
      );
    }
    try {
      await chromaMcp.callTool('chroma_create_collection', {
        collection_name: this.collectionName,
        embedding_function_name: embeddingFunction
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('already exists')) {
        throw error;
      }
      // Collection already exists - this is the expected path after first creation
    }

    this.collectionEnsuredGeneration = ChromaSync.collectionGeneration;

    logger.debug('CHROMA_SYNC', 'Collection ready', {
      collection: this.collectionName
    });
  }

  private static isCorruptSegmentError(error: unknown): boolean {
    if (error instanceof ChromaUnavailableError) {
      return false;
    }
    const message = error instanceof Error ? error.message : String(error);
    return message.includes(CORRUPT_SEGMENT_ERROR_SIGNATURE);
  }

  /**
   * A batch failed with the corrupt segment signature. Once that has happened
   * on CORRUPT_SEGMENT_CONFIRMING_BATCHES distinct batches, drop the
   * collection and throw ChromaCorruptCollectionError. Until then return, so
   * the batch counts as an ordinary failed write.
   */
  private async handleCorruptSegmentFailure(batch: ChromaDocument[], error: unknown): Promise<void> {
    const cause = error instanceof Error ? error : new Error(String(error));
    const failedBatches = ChromaSync.corruptSegmentBatches.get(this.collectionName) ?? new Set<string>();
    failedBatches.add(batch[0]?.id ?? '');
    ChromaSync.corruptSegmentBatches.set(this.collectionName, failedBatches);

    if (failedBatches.size < CORRUPT_SEGMENT_CONFIRMING_BATCHES) {
      logger.warn('CHROMA_SYNC', 'HNSW segment failed to apply its log; the collection is dropped if another batch fails the same way', {
        collection: this.collectionName
      });
      return;
    }
    if (ChromaSync.droppedCollections.has(this.collectionName)) {
      logger.error('CHROMA_SYNC', 'Collection still has a corrupt HNSW segment after this process dropped it (or tried to); not dropping it again in this process', {
        collection: this.collectionName
      }, cause);
      return;
    }

    await this.dropCorruptCollection(cause);
    throw new ChromaCorruptCollectionError(
      `Corrupt collection ${this.collectionName} dropped; rebuilding it from SQLite`,
      cause
    );
  }

  /**
   * Drop a collection whose HNSW segment is stuck (#3202) and rebuild it from
   * SQLite, the source of truth. Every write to such a segment fails the same
   * way and makes chroma-mcp replay its write-ahead log in memory (about
   * 20 GB within 4 minutes on the reporting host), so retrying never helps.
   *
   * The collection is shared by every project, so every project is flagged
   * for a rebuild from zero (see ChromaSyncState.resetForRebuild). Bumping
   * the generation stops backfill runs still writing into the old collection;
   * a running sweep then starts over, otherwise a new sweep starts here. If
   * the worker stops first, the persisted flags make the next start rebuild.
   *
   * The rebuild is booked before the delete is sent, and the generation moves
   * whether or not the call resolves: chroma-mcp can commit the delete and
   * still reject the call (a request deadline on a large collection). Booked
   * afterwards, a rejection left the watermarks claiming every row the
   * dropped collection took with it, and semantic search lost them silently.
   * A rejected delete is retried on a later failing batch, since it may never
   * have reached chroma-mcp, but only MAX_FAILED_DROP_ATTEMPTS times, so a
   * delete that keeps failing cannot restart the backfill sweep forever.
   * chroma-mcp serves requests one at a time, so the rebuild's writes only
   * run after a slow delete has finished.
   */
  private async dropCorruptCollection(cause: Error): Promise<void> {
    const chromaMcp = ChromaMcpManager.getInstance();
    let documentCount: number | null = null;
    try {
      const count = await chromaMcp.callTool('chroma_get_collection_count', {
        collection_name: this.collectionName
      });
      documentCount = typeof count === 'number' ? count : null;
    } catch (error) {
      logger.debug('CHROMA_SYNC', 'Could not count the corrupt collection before dropping it', {
        collection: this.collectionName,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    logger.error('CHROMA_SYNC', 'Chroma collection has a corrupt HNSW segment; dropping it and rebuilding from SQLite', {
      collection: this.collectionName,
      documentCount,
      chromaMode: settings.CLAUDE_MEM_CHROMA_MODE || 'local',
      chromaDataDir: settings.CLAUDE_MEM_CHROMA_MODE === 'remote' ? undefined : paths.chroma()
    }, cause);

    ChromaSyncState.markAllForRebuild();
    try {
      await chromaMcp.callTool('chroma_delete_collection', {
        collection_name: this.collectionName
      });
      ChromaSync.droppedCollections.add(this.collectionName);
      ChromaSync.corruptSegmentBatches.delete(this.collectionName);
      ChromaSync.lastCollectionDrop = {
        collection: this.collectionName,
        droppedAt: new Date().toISOString(),
        documentCount,
        error: cause.message
      };
    } catch (error) {
      const failedAttempts = (ChromaSync.failedDropAttempts.get(this.collectionName) ?? 0) + 1;
      ChromaSync.failedDropAttempts.set(this.collectionName, failedAttempts);
      if (failedAttempts >= ChromaSync.MAX_FAILED_DROP_ATTEMPTS) {
        ChromaSync.droppedCollections.add(this.collectionName);
      }
      throw error;
    } finally {
      ChromaSync.collectionGeneration += 1;
      this.startRebuildSweep();
    }
  }

  private startRebuildSweep(): void {
    if (ChromaSync.backfillInProgress) {
      return;
    }
    if (!ChromaSync.backfillStore) {
      logger.warn('CHROMA_SYNC', 'Collection dropped; it is rebuilt on the next worker start', {
        collection: this.collectionName
      });
      return;
    }
    void ChromaSync.backfillAllProjects(ChromaSync.backfillStore).catch((error) => {
      logger.error('CHROMA_SYNC', 'Rebuild after dropping a corrupt collection failed; the next worker start retries it', {
        collection: this.collectionName
      }, error instanceof Error ? error : new Error(String(error)));
    });
  }

  private formatObservationDocs(obs: StoredObservation): ChromaDocument[] {
    const documents: ChromaDocument[] = [];

    const facts = parseStringListField(obs.facts, 'facts', obs.id);
    const concepts = parseStringListField(obs.concepts, 'concepts', obs.id);
    // parseFileList is SQLite-shaped (`bun:sqlite` in the import chain) —
    // resolve it through the deferred loader so this method stays out of
    // the SDK bundle's import graph. Plan §3.
    const filesHelper = loadFilesHelper();
    const files_read = filesHelper.parseFileList(obs.files_read);
    const files_modified = filesHelper.parseFileList(obs.files_modified);

    const baseMetadata: Record<string, string | number | null> = {
      sqlite_id: obs.id,
      doc_type: 'observation',
      memory_session_id: obs.memory_session_id,
      project: obs.project,
      merged_into_project: obs.merged_into_project ?? null,
      platform_source: obs.platform_source
        ? normalizePlatformSource(obs.platform_source)
        : normalizePlatformSource(undefined),
      created_at_epoch: obs.created_at_epoch,
      type: obs.type || 'discovery',
      title: obs.title || 'Untitled'
    };

    if (obs.subtitle) {
      baseMetadata.subtitle = obs.subtitle;
    }
    if (concepts.length > 0) {
      baseMetadata.concepts = concepts.join(',');
    }
    if (files_read.length > 0) {
      baseMetadata.files_read = files_read.join(',');
    }
    if (files_modified.length > 0) {
      baseMetadata.files_modified = files_modified.join(',');
    }

    if (obs.narrative) {
      documents.push({
        id: `obs_${obs.id}_narrative`,
        document: obs.narrative,
        metadata: { ...baseMetadata, field_type: 'narrative' }
      });
    }

    if (obs.text) {
      documents.push({
        id: `obs_${obs.id}_text`,
        document: obs.text,
        metadata: { ...baseMetadata, field_type: 'text' }
      });
    }

    facts.forEach((fact: string, index: number) => {
      documents.push({
        id: `obs_${obs.id}_fact_${index}`,
        document: fact,
        metadata: { ...baseMetadata, field_type: 'fact', fact_index: index }
      });
    });

    // An observation with no narrative, text or facts still has a title. It
    // used to produce no document at all, so it was never searchable while the
    // watermark moved past it (#4069: over a third of one host's gap). Index
    // its title and subtitle as one document instead.
    if (documents.length === 0) {
      const titleText = observationTitleText(obs);
      if (titleText) {
        documents.push({
          id: `obs_${obs.id}_title`,
          document: titleText,
          metadata: { ...baseMetadata, field_type: 'title' }
        });
      }
    }

    return documents;
  }

  private formatSummaryDocs(summary: StoredSummary): ChromaDocument[] {
    const documents: ChromaDocument[] = [];

    const baseMetadata: Record<string, string | number | null> = {
      sqlite_id: summary.id,
      doc_type: 'session_summary',
      memory_session_id: summary.memory_session_id,
      project: summary.project,
      merged_into_project: summary.merged_into_project ?? null,
      platform_source: summary.platform_source
        ? normalizePlatformSource(summary.platform_source)
        : normalizePlatformSource(undefined),
      created_at_epoch: summary.created_at_epoch,
      prompt_number: summary.prompt_number || 0
    };

    if (summary.request) {
      documents.push({
        id: `summary_${summary.id}_request`,
        document: summary.request,
        metadata: { ...baseMetadata, field_type: 'request' }
      });
    }

    if (summary.investigated) {
      documents.push({
        id: `summary_${summary.id}_investigated`,
        document: summary.investigated,
        metadata: { ...baseMetadata, field_type: 'investigated' }
      });
    }

    if (summary.learned) {
      documents.push({
        id: `summary_${summary.id}_learned`,
        document: summary.learned,
        metadata: { ...baseMetadata, field_type: 'learned' }
      });
    }

    if (summary.completed) {
      documents.push({
        id: `summary_${summary.id}_completed`,
        document: summary.completed,
        metadata: { ...baseMetadata, field_type: 'completed' }
      });
    }

    if (summary.next_steps) {
      documents.push({
        id: `summary_${summary.id}_next_steps`,
        document: summary.next_steps,
        metadata: { ...baseMetadata, field_type: 'next_steps' }
      });
    }

    if (summary.notes) {
      documents.push({
        id: `summary_${summary.id}_notes`,
        document: summary.notes,
        metadata: { ...baseMetadata, field_type: 'notes' }
      });
    }

    return documents;
  }

  /**
   * Write `documents` to Chroma in BATCH_SIZE-sized batches.
   *
   * Returns the number of documents that were successfully written (or
   * confirmed via delete+add reconcile). Per-batch failures are logged and
   * the loop continues, so callers must use the returned count to advance
   * their watermark, otherwise an interrupted backfill can mark unsynced
   * records as synced. The one exception is a confirmed corrupt HNSW segment
   * (#3202): the collection is dropped for a rebuild and this throws
   * ChromaCorruptCollectionError, because retrying such a write never helps.
   *
   * Visibility: promoted from `private` to `public` for cmem-sdk Phase 6.
   * The SDK indexes Postgres observations into Chroma using this same
   * storage-agnostic document layer — same retry/dedupe semantics, same
   * BATCH_SIZE. SQLite-shaped `syncObservation` is NOT reusable for the
   * Postgres UUID path. See plan §6 line 244-247.
   */
  public async addDocuments(documents: ChromaDocument[]): Promise<number> {
    if (documents.length === 0) {
      return 0;
    }

    // SQLite FTS5's trigram tokenizer accepts NUL-containing TEXT but builds
    // an index that subsequently fails PRAGMA quick_check / integrity_check as
    // "malformed inverted index". Codex transcripts can legitimately contain
    // NUL bytes copied from terminal or binary output, so sanitize at the last
    // common boundary before every Chroma add/update path. U+FFFD preserves a
    // visible boundary without making unrelated text run together.
    let nulSanitizedDocuments = 0;
    const safeDocuments = documents.map(document => {
      if (!document.document.includes('\0')) return document;
      nulSanitizedDocuments += 1;
      return {
        ...document,
        document: document.document.replaceAll('\0', '�'),
      };
    });
    if (nulSanitizedDocuments > 0) {
      logger.warn('CHROMA_SYNC', 'Sanitized NUL bytes before Chroma FTS indexing', {
        collection: this.collectionName,
        documents: nulSanitizedDocuments,
      });
    }

    try {
      await this.ensureCollectionExists();
    } catch (error) {
      if (error instanceof ChromaUnavailableError) {
        logger.warn('CHROMA_SYNC', 'Chroma unavailable before write; leaving documents unsynced', {
          collection: this.collectionName,
          requested: documents.length,
          error: error.message
        });
        return 0;
      }
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error('CHROMA_SYNC', 'Unexpected error ensuring collection before write', {
        collection: this.collectionName,
        requested: documents.length
      }, err);
      throw error;
    }

    const chromaMcp = ChromaMcpManager.getInstance();

    let written = 0;
    for (let i = 0; i < safeDocuments.length; i += this.BATCH_SIZE) {
      const batch = safeDocuments.slice(i, i + this.BATCH_SIZE);

      const cleanMetadatas = batch.map(d =>
        Object.fromEntries(
          Object.entries(d.metadata).filter(([_, v]) => v !== null && v !== undefined && v !== '')
        )
      );

      try {
        await chromaMcp.callTool('chroma_add_documents', {
          collection_name: this.collectionName,
          ids: batch.map(d => d.id),
          documents: batch.map(d => d.document),
          metadatas: cleanMetadatas
        });
        written += batch.length;
        // A write that lands proves the segment is not stuck.
        ChromaSync.corruptSegmentBatches.delete(this.collectionName);
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        if (errMsg.includes('already exist')) {
          try {
            // Reconcile without delete+add. Document IDs are deterministic
            // (e.g. obs_<sqlite_id>_narrative), so every resync, backfill,
            // retry, or interruption collides on the same IDs. HNSW deletions
            // are soft-deletes: a delete+add cycle leaves the old graph nodes
            // in link_lists.bin while appending new ones, so the on-disk index
            // grows without bound and can exhaust disk/RAM.
            //
            // chroma_add_documents rejects the WHOLE batch when any single ID
            // already exists, so a mixed batch may contain both colliding IDs
            // and genuinely-new IDs. chroma_update_documents silently ignores
            // IDs that are not already present, so a blanket update would
            // overwrite the duplicates but never insert the new docs — while
            // still advancing the watermark past them (data loss). So split
            // the batch: update the existing IDs in place, add only the new
            // ones, and count each part only if it actually succeeds.
            const existing = await chromaMcp.callTool('chroma_get_documents', {
              collection_name: this.collectionName,
              ids: batch.map(d => d.id),
              include: []
            }) as { ids?: string[] };
            const existingIds = new Set(existing?.ids ?? []);

            const toUpdate = batch.filter(d => existingIds.has(d.id));
            const toAdd = batch.filter(d => !existingIds.has(d.id));
            const cleanFor = (docs: ChromaDocument[]) => docs.map(d =>
              Object.fromEntries(
                Object.entries(d.metadata).filter(([_, v]) => v !== null && v !== undefined && v !== '')
              )
            );

            if (toUpdate.length > 0) {
              await chromaMcp.callTool('chroma_update_documents', {
                collection_name: this.collectionName,
                ids: toUpdate.map(d => d.id),
                documents: toUpdate.map(d => d.document),
                metadatas: cleanFor(toUpdate)
              });
              written += toUpdate.length;
            }

            if (toAdd.length > 0) {
              await chromaMcp.callTool('chroma_add_documents', {
                collection_name: this.collectionName,
                ids: toAdd.map(d => d.id),
                documents: toAdd.map(d => d.document),
                metadatas: cleanFor(toAdd)
              });
              written += toAdd.length;
            }

            logger.info('CHROMA_SYNC', 'Batch reconciled via in-place update + add after duplicate conflict', {
              collection: this.collectionName,
              batchStart: i,
              batchSize: batch.length,
              updated: toUpdate.length,
              added: toAdd.length
            });
            ChromaSync.corruptSegmentBatches.delete(this.collectionName);
          } catch (reconcileError) {
            if (ChromaSync.isCorruptSegmentError(reconcileError)) {
              await this.handleCorruptSegmentFailure(batch, reconcileError);
            }
            logger.error('CHROMA_SYNC', 'Batch reconcile (update+add) failed — watermark will not advance for this batch', {
              collection: this.collectionName,
              batchStart: i,
              batchSize: batch.length
            }, reconcileError as Error);
          }
        } else {
          if (ChromaSync.isCorruptSegmentError(error)) {
            await this.handleCorruptSegmentFailure(batch, error);
          }
          logger.error('CHROMA_SYNC', 'Batch add failed — watermark will not advance for this batch, continuing with remaining batches', {
            collection: this.collectionName,
            batchStart: i,
            batchSize: batch.length
          }, error as Error);
        }
      }
    }

    logger.debug('CHROMA_SYNC', 'Documents added', {
      collection: this.collectionName,
      requested: documents.length,
      written
    });
    return written;
  }

  /** Remove only disappeared fragments; surviving deterministic IDs update in place. */
  private async removeObsoleteFragments(docType: string, sqliteId: number, documents: ChromaDocument[]): Promise<void> {
    await this.ensureCollectionExists();
    const manager = ChromaMcpManager.getInstance();
    const existing = await manager.callTool('chroma_get_documents', {
      collection_name: this.collectionName,
      where: { $and: [{ doc_type: docType }, { sqlite_id: sqliteId }] },
      include: [],
    });
    // MCP transport success can still decode to null (empty/non-JSON content).
    // Only a valid ID list proves which fragments exist; failures must leave
    // the durable reconciliation flag set for the next backfill.
    if (!existing || typeof existing !== 'object' || !('ids' in existing)
      || !Array.isArray(existing.ids)
      || !existing.ids.every(id => typeof id === 'string' && id.length > 0)) {
      throw new Error('Chroma fragment lookup did not return a valid document ID list');
    }
    const currentIds = new Set(documents.map(doc => doc.id));
    const obsolete = (existing.ids as string[]).filter(id => !currentIds.has(id));
    for (let i = 0; i < obsolete.length; i += this.BATCH_SIZE) {
      await manager.callTool('chroma_delete_documents', { collection_name: this.collectionName, ids: obsolete.slice(i, i + this.BATCH_SIZE) });
    }
  }

  async syncObservation(
    observationId: number,
    memorySessionId: string,
    project: string,
    obs: ParsedObservation & { text?: string | null; merged_into_project?: string | null },
    promptNumber: number,
    createdAtEpoch: number,
    platformSource?: string,
    replaceExisting = false
  ): Promise<void> {
    const stored: StoredObservation = {
      id: observationId,
      memory_session_id: memorySessionId,
      project: project,
      // New local observations have neither; a replicated row passes its
      // stored values so these documents match what backfill writes.
      merged_into_project: obs.merged_into_project ?? null,
      platform_source: platformSource ? normalizePlatformSource(platformSource) : normalizePlatformSource(undefined),
      text: obs.text ?? null,
      type: obs.type,
      title: obs.title,
      subtitle: obs.subtitle,
      facts: JSON.stringify(obs.facts),
      narrative: obs.narrative,
      concepts: JSON.stringify(obs.concepts),
      files_read: JSON.stringify(obs.files_read),
      files_modified: JSON.stringify(obs.files_modified),
      prompt_number: promptNumber,
      created_at_epoch: createdAtEpoch
    };

    const documents = this.formatObservationDocs(stored);

    logger.info('CHROMA_SYNC', 'Syncing observation', {
      observationId,
      documentCount: documents.length,
      project
    });

    // Only advance the watermark on a confirmed full write. addDocuments() now
    // returns a written count and tolerates per-batch failures, so a transient
    // Chroma error must NOT mark this observation as synced — otherwise the
    // backfill pass on next boot will skip past it (CodeRabbit review on PR
    // #2282).
    if (replaceExisting) ChromaSyncState.markFragmentReconciliation(project, 'observations', observationId);
    if (ChromaSyncState.needsFragmentReconciliation(project, 'observations', observationId)) {
      await this.removeObsoleteFragments('observation', observationId, documents);
      ChromaSyncState.clearFragmentReconciliation(project, 'observations', observationId);
    }
    const written = await this.addDocuments(documents);
    if (written === documents.length) {
      ChromaSyncState.clearPending(project, 'observations', [observationId]);
      ChromaSyncState.bump(project, 'observations', observationId);
    } else {
      // Not bumping is not enough: the watermark is a high-water mark, so the
      // next row that does write would skip past this one for good (#3917).
      // Record it as pending so the backfill retries it, like backfillKind().
      ChromaSyncState.markPending(project, 'observations', [observationId]);
      logger.warn('CHROMA_SYNC', 'Observation watermark bump skipped — partial write, row marked pending', {
        observationId,
        project,
        requested: documents.length,
        written
      });
    }
  }

  async syncSummary(
    summaryId: number,
    memorySessionId: string,
    project: string,
    summary: ParsedSummary & { merged_into_project?: string | null },
    promptNumber: number,
    createdAtEpoch: number,
    platformSource?: string,
    replaceExisting = false
  ): Promise<void> {
    const stored: StoredSummary = {
      id: summaryId,
      memory_session_id: memorySessionId,
      project: project,
      merged_into_project: summary.merged_into_project ?? null,
      platform_source: platformSource ? normalizePlatformSource(platformSource) : normalizePlatformSource(undefined),
      request: summary.request,
      investigated: summary.investigated,
      learned: summary.learned,
      completed: summary.completed,
      next_steps: summary.next_steps,
      notes: summary.notes,
      prompt_number: promptNumber,
      created_at_epoch: createdAtEpoch
    };

    const documents = this.formatSummaryDocs(stored);

    logger.info('CHROMA_SYNC', 'Syncing summary', {
      summaryId,
      documentCount: documents.length,
      project
    });

    // Only bump on a confirmed full write — see syncObservation() for rationale.
    if (replaceExisting) ChromaSyncState.markFragmentReconciliation(project, 'summaries', summaryId);
    if (ChromaSyncState.needsFragmentReconciliation(project, 'summaries', summaryId)) {
      await this.removeObsoleteFragments('session_summary', summaryId, documents);
      ChromaSyncState.clearFragmentReconciliation(project, 'summaries', summaryId);
    }
    const written = await this.addDocuments(documents);
    if (written === documents.length) {
      ChromaSyncState.clearPending(project, 'summaries', [summaryId]);
      ChromaSyncState.bump(project, 'summaries', summaryId);
    } else {
      ChromaSyncState.markPending(project, 'summaries', [summaryId]);
      logger.warn('CHROMA_SYNC', 'Summary watermark bump skipped — partial write, row marked pending', {
        summaryId,
        project,
        requested: documents.length,
        written
      });
    }
  }

  private formatUserPromptDoc(prompt: StoredUserPrompt): ChromaDocument {
    return {
      id: `prompt_${prompt.id}`,
      document: prompt.prompt_text,
      metadata: {
        sqlite_id: prompt.id,
        doc_type: 'user_prompt',
        memory_session_id: prompt.memory_session_id,
        project: prompt.project,
        platform_source: prompt.platform_source,
        created_at_epoch: prompt.created_at_epoch,
        prompt_number: prompt.prompt_number
      }
    };
  }

  async syncUserPrompt(
    promptId: number,
    memorySessionId: string,
    project: string,
    promptText: string,
    promptNumber: number,
    createdAtEpoch: number,
    platformSource?: string
  ): Promise<void> {
    const stored: StoredUserPrompt = {
      id: promptId,
      content_session_id: '', // Not needed for Chroma sync
      prompt_number: promptNumber,
      prompt_text: promptText,
      created_at_epoch: createdAtEpoch,
      memory_session_id: memorySessionId,
      project: project,
      platform_source: normalizePlatformSource(platformSource)
    };

    const document = this.formatUserPromptDoc(stored);

    logger.info('CHROMA_SYNC', 'Syncing user prompt', {
      promptId,
      project
    });

    // Only bump on a confirmed full write — see syncObservation() for rationale.
    const written = await this.addDocuments([document]);
    if (written === 1) {
      ChromaSyncState.clearPending(project, 'prompts', [promptId]);
      ChromaSyncState.bump(project, 'prompts', promptId);
    } else {
      ChromaSyncState.markPending(project, 'prompts', [promptId]);
      logger.warn('CHROMA_SYNC', 'Prompt watermark bump skipped — write failed, row marked pending', {
        promptId,
        project,
        written
      });
    }
  }

  private mergeRowsById<T extends { id: number }>(rows: T[], pendingRows: T[]): T[] {
    const merged = new Map<number, T>();
    for (const row of rows) {
      merged.set(row.id, row);
    }
    for (const row of pendingRows) {
      merged.set(row.id, row);
    }
    return [...merged.values()].sort((a, b) => a.id - b.id);
  }

  private summarizeBootstrapPending(
    sourceIds: number[],
    existingIds: Set<number>
  ): { watermark: number; pending: number[] } {
    const watermark = existingIds.size ? Math.max(...existingIds) : 0;
    return {
      watermark,
      pending: sourceIds.filter(id => id <= watermark && !existingIds.has(id)),
    };
  }

  private async getExistingChromaIds(project: string): Promise<{
    observations: Set<number>;
    summaries: Set<number>;
    prompts: Set<number>;
    documents: Set<string>;
  }> {
    await this.ensureCollectionExists();

    const chromaMcp = ChromaMcpManager.getInstance();

    const observationIds = new Set<number>();
    const summaryIds = new Set<number>();
    const promptIds = new Set<number>();
    const documentIds = new Set<string>();

    let offset = 0;
    const limit = 1000; 

    logger.info('CHROMA_SYNC', 'Fetching existing Chroma document IDs...', { project });

    while (true) {
      const result = await chromaMcp.callTool('chroma_get_documents', {
        collection_name: this.collectionName,
        limit: limit,
        offset: offset,
        where: { project },
        include: ['metadatas']
      }) as any;

      for (const id of result?.ids ?? []) documentIds.add(id);
      const metadatas = result?.metadatas || [];

      if (metadatas.length === 0) {
        break; 
      }

      for (const meta of metadatas) {
        if (meta && meta.sqlite_id) {
          const sqliteId = meta.sqlite_id as number;
          if (meta.doc_type === 'observation') {
            observationIds.add(sqliteId);
          } else if (meta.doc_type === 'session_summary') {
            summaryIds.add(sqliteId);
          } else if (meta.doc_type === 'user_prompt') {
            promptIds.add(sqliteId);
          }
        }
      }

      offset += limit;

      logger.debug('CHROMA_SYNC', 'Fetched batch of existing IDs', {
        project,
        offset,
        batchSize: metadatas.length
      });
    }

    logger.info('CHROMA_SYNC', 'Existing IDs fetched', {
      project,
      observations: observationIds.size,
      summaries: summaryIds.size,
      prompts: promptIds.size,
      total: observationIds.size + summaryIds.size + promptIds.size
    });

    return { observations: observationIds, summaries: summaryIds, prompts: promptIds, documents: documentIds };
  }

  async bootstrapWatermarksFromChroma(project: string, store: SessionStore): Promise<void> {
    const existing = await this.getExistingChromaIds(project);
    // A row can span several Chroma documents. Seeing one fragment is not
    // proof the others landed before a restart or a lost watermark file.
    // Stream source rows so checking completeness does not materialize the
    // whole project's text in memory.
    const completeRows = <T extends { id: number }>(
      sql: string,
      existingIds: Set<number>,
      format: (row: T) => ChromaDocument[],
    ): { sourceIds: number[]; completeIds: Set<number> } => {
      const sourceIds: number[] = [];
      const completeIds = new Set<number>();
      const statement = store.db.prepare(sql);
      try {
        for (const row of streamRows(statement, project) as Iterable<T>) {
          sourceIds.push(row.id);
          if (!existingIds.has(row.id)) continue;
          if (format(row).every(document => existing.documents.has(document.id))) {
            completeIds.add(row.id);
          }
        }
      } finally {
        statement.finalize();
      }
      return { sourceIds, completeIds };
    };
    const observationRows = completeRows<StoredObservation>(
      'SELECT o.* FROM observations o WHERE o.project = ? ORDER BY o.id ASC',
      existing.observations,
      row => this.formatObservationDocs(row),
    );
    const summaryRows = completeRows<StoredSummary>(
      'SELECT * FROM session_summaries WHERE project = ? ORDER BY id ASC',
      existing.summaries,
      row => this.formatSummaryDocs(row),
    );
    const promptIds = store.db.prepare(`
      SELECT up.id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      WHERE s.project = ?
      ORDER BY up.id ASC
    `).all(project) as Array<{ id: number }>;
    const observationBootstrap = this.summarizeBootstrapPending(observationRows.sourceIds, observationRows.completeIds);
    const summaryBootstrap = this.summarizeBootstrapPending(summaryRows.sourceIds, summaryRows.completeIds);
    const promptBootstrap = this.summarizeBootstrapPending(promptIds.map(row => row.id), existing.prompts);

    ChromaSyncState.replace(project, {
      observations: observationBootstrap.watermark,
      summaries: summaryBootstrap.watermark,
      prompts: promptBootstrap.watermark,
      pending: {
        observations: observationBootstrap.pending,
        summaries: summaryBootstrap.pending,
        prompts: promptBootstrap.pending,
      }
    });
    logger.info('CHROMA_SYNC', 'Bootstrapped watermarks from Chroma', {
      project,
      watermarks: ChromaSyncState.get(project)
    });
  }

  /**
   * Backfill one project's rows above its watermarks. Resolves 'completed' when
   * every row's documents actually landed, 'rows_pending' when every row was
   * attempted but some writes failed, otherwise why the run stopped early (a
   * worker shutdown, repeated write failures, or a dropped collection). The
   * next run resumes from the watermarks and pending rows.
   */
  async ensureBackfilled(project: string, store: SessionStore): Promise<BackfillOutcome> {
    if (shutdownBegan()) {
      logger.info('CHROMA_SYNC', 'Backfill skipped: worker shutdown began', { project });
      return 'shutdown';
    }
    logger.info('CHROMA_SYNC', 'Starting smart backfill', { project });

    try {
      await this.ensureCollectionExists();
    } catch (error) {
      // stop() can begin while the create call is in flight; Chroma then
      // refuses it. That is an interrupted run, not a failed one.
      if (shutdownBegan()) {
        logger.info('CHROMA_SYNC', 'Backfill stopped: worker shutdown began', { project });
        return 'shutdown';
      }
      throw error;
    }

    const rebuilding = ChromaSyncState.isRebuildPending(project);
    if (rebuilding) {
      // This project's documents went with a dropped corrupt collection
      // (#3202). Start from zero: live writes may have bumped its watermark
      // since the drop, and that must not hide older rows from the rebuild.
      ChromaSyncState.resetForRebuild(project);
      logger.info('CHROMA_SYNC', 'Rebuilding project from SQLite after a corrupt collection was dropped', { project });
    }
    const watermarks = ChromaSyncState.get(project);

    try {
      const outcome = await this.runBackfillPipeline(store, project, watermarks);
      // A rebuild is done once every row was attempted. Rows that failed are
      // pending, and finishRebuild keeps them; restarting the rebuild from
      // zero would re-embed the whole project just to retry those rows.
      if (rebuilding && (outcome === 'completed' || outcome === 'rows_pending')) {
        ChromaSyncState.finishRebuild(project);
      }
      return outcome;
    } catch (error) {
      logger.error('CHROMA_SYNC', 'Backfill failed', { project }, error instanceof Error ? error : new Error(String(error)));
      throw new Error(`Backfill failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async runBackfillPipeline(
    db: SessionStore,
    backfillProject: string,
    watermarks: ProjectWatermarks
  ): Promise<BackfillOutcome> {
    const observations = await this.backfillObservations(db, backfillProject, watermarks.observations);
    if (observations.abortReason) {
      return observations.abortReason;
    }
    const summaries = await this.backfillSummaries(db, backfillProject, watermarks.summaries);
    if (summaries.abortReason) {
      return summaries.abortReason;
    }
    const prompts = await this.backfillPrompts(db, backfillProject, watermarks.prompts);
    if (prompts.abortReason) {
      return prompts.abortReason;
    }

    // An isolated write failure stops neither its own kind's run nor the kinds
    // after it: the failed rows stay pending for the next sweep, and the
    // project reports 'rows_pending' rather than claiming it finished (#4264).
    const writeFailures = observations.writeFailures || summaries.writeFailures || prompts.writeFailures;

    logger.info('CHROMA_SYNC',
      writeFailures ? 'Smart backfill finished with write failures' : 'Smart backfill complete', {
      project: backfillProject,
      writeFailures,
      synced: {
        observationDocs: observations.writtenDocs,
        summaryDocs: summaries.writtenDocs,
        promptDocs: prompts.writtenDocs
      },
      emptyRows: observations.emptyRows + summaries.emptyRows + prompts.emptyRows,
      watermarks: ChromaSyncState.get(backfillProject)
    });
    return writeFailures ? 'rows_pending' : 'completed';
  }

  /**
   * Shared batch/watermark loop for all three backfill kinds. Returns how
   * many documents actually landed, how many rows were drained as empty,
   * whether any row's write failed, and why the run stopped early, if it did
   * (worker shutdown, the consecutive-failure guard, or a dropped collection).
   * Isolated write failures do not stop the run: the kind reports them via
   * `writeFailures` instead of `abortReason`, so the pipeline keeps going and
   * the project is reported as 'rows_pending' rather than claimed complete
   * while a document is missing.
   *
   * Watermark durability is row-atomic, not batch-atomic: one observation or
   * summary can expand into several Chroma documents and span multiple
   * BATCH_SIZE writes. We only clear pending state and bump the row watermark
   * after every document for that row lands, otherwise a later batch failure or
   * restart can strand the tail of a split row forever.
   *
   * Abort state is local to this call's return value, not an instance field:
   * backfillAllProjects runs several projects concurrently on one ChromaSync
   * instance, so a shared flag would let one project's abort spuriously stop
   * another (#4069).
   */
  private async backfillKind<T extends { id: number }>(
    rows: T[],
    formatDocs: (row: T) => ChromaDocument[],
    kind: 'observations' | 'summaries' | 'prompts',
    backfillProject: string
  ): Promise<BackfillKindResult> {
    const rowsWithDocs: Array<{ row: T; docs: ChromaDocument[] }> = [];
    for (const row of rows) {
      try {
        rowsWithDocs.push({ row, docs: formatDocs(row) });
      } catch (error) {
        // A single unformattable row (e.g. a malformed JSON column) must not
        // abort the whole backfill. Skip and log it so the rest of the run
        // proceeds. Mark the id pending so a later higher-id row that advances
        // the watermark does not strand it: the pending path re-fetches it on
        // the next run, which self-heals once its format issue is resolved.
        ChromaSyncState.markPending(backfillProject, kind, [row.id]);
        logger.warn('CHROMA_SYNC', 'Skipped unformattable row during backfill', {
          project: backfillProject,
          kind,
          rowId: row.id
        }, error instanceof Error ? error : new Error(String(error)));
      }
    }
    const totalDocs = rowsWithDocs.reduce((sum, { docs }) => sum + docs.length, 0);
    let processedDocs = 0;
    let writtenDocs = 0;
    let emptyRows = 0;
    let consecutiveFailures = 0;
    let hadWriteFailures = false;
    // A corrupt collection dropped mid-run (#3202) took this run's writes with
    // it; nothing may be bumped after that, since every project is rebuilt.
    const generation = ChromaSync.collectionGeneration;
    const collectionDropped = (): BackfillKindResult | null => {
      if (ChromaSync.collectionGeneration === generation) {
        return null;
      }
      logger.info('CHROMA_SYNC', 'Backfill stopped: the collection was dropped for a rebuild', {
        project: backfillProject,
        kind
      });
      return { writtenDocs, emptyRows, abortReason: 'collection_dropped', writeFailures: false };
    };

    for (let rowIndex = 0; rowIndex < rowsWithDocs.length; rowIndex += 1) {
      const { row, docs } = rowsWithDocs[rowIndex];
      const droppedBeforeRow = collectionDropped();
      if (droppedBeforeRow) {
        return droppedBeforeRow;
      }
      if (ChromaSyncState.needsFragmentReconciliation(backfillProject, kind, row.id)) {
        try {
          await this.removeObsoleteFragments(kind === 'observations' ? 'observation' : 'session_summary', row.id, docs);
          ChromaSyncState.clearFragmentReconciliation(backfillProject, kind, row.id);
        } catch (error) {
          hadWriteFailures = true;
          consecutiveFailures += 1;
          logger.warn('CHROMA_SYNC', 'Fragment reconciliation failed; row remains pending', { project: backfillProject, kind, rowId: row.id }, error as Error);
          if (consecutiveFailures >= this.MAX_CONSECUTIVE_BATCH_FAILURES) {
            return { writtenDocs, emptyRows, abortReason: 'write_failures', writeFailures: true };
          }
          continue;
        }
      }
      if (docs.length === 0) {
        // Nothing to index at all: no title and no body (a title-only
        // observation still gets its title document). Drain the row so it
        // stops being reported missing on every sweep; it is vacuously synced
        // and counted in the completion log (#4069).
        ChromaSyncState.clearPending(backfillProject, kind, [row.id]);
        ChromaSyncState.bump(backfillProject, kind, row.id);
        emptyRows += 1;
        continue;
      }

      let rowComplete = true;
      for (let i = 0; i < docs.length; i += this.BATCH_SIZE) {
        // Checked before every batch, not once per row: a row can span
        // several batches, and shutdown can begin between any two of them.
        if (shutdownBegan()) {
          if (i > 0) {
            // Part of this row landed; keep it pending like any partial write.
            ChromaSyncState.markPending(backfillProject, kind, [row.id]);
          }
          rowComplete = false;
          break;
        }
        const batch = docs.slice(i, i + this.BATCH_SIZE);
        let writtenInBatch: number;
        try {
          writtenInBatch = await this.addDocuments(batch);
        } catch (error) {
          if (error instanceof ChromaCorruptCollectionError) {
            return collectionDropped() ?? { writtenDocs, emptyRows, abortReason: 'collection_dropped', writeFailures: false };
          }
          throw error;
        }
        processedDocs += batch.length;
        writtenDocs += writtenInBatch;
        // Only advance the watermark for documents that actually landed in
        // Chroma. addDocuments() logs and continues on per-batch failures, so a
        // partial write must not mark unwritten docs as synced.
        if (writtenInBatch < batch.length) {
          ChromaSyncState.markPending(backfillProject, kind, [row.id]);
          logger.debug('CHROMA_SYNC', 'Recorded pending watermark gap for failed/partial row batch', {
            project: backfillProject,
            kind,
            rowId: row.id,
            batchStart: i,
            requested: batch.length,
            written: writtenInBatch
          });
          rowComplete = false;
          break;
        }

        consecutiveFailures = 0;
        logger.debug('CHROMA_SYNC', 'Backfill progress', {
          project: backfillProject,
          progress: `${Math.min(processedDocs, totalDocs)}/${totalDocs}`
        });
      }

      if (!rowComplete) {
        // Once the worker begins shutting down, local Chroma refuses every
        // write (#4069), including one already in flight. Stop the run rather
        // than walking the remaining rows through the same refusal; they stay
        // above the watermark or pending and the next start resumes from them.
        if (shutdownBegan()) {
          logger.info('CHROMA_SYNC', 'Backfill stopped: worker shutdown began', {
            project: backfillProject,
            kind,
            lastRowId: row.id,
            remainingRows: rowsWithDocs.length - rowIndex - 1
          });
          return { writtenDocs, emptyRows, abortReason: 'shutdown', writeFailures: false };
        }

        consecutiveFailures += 1;
        hadWriteFailures = true;
        // A write that fails for several rows in a row is not a per-row
        // problem, it is Chroma refusing writes. Walking every remaining row
        // through the same failure logs one identical error per row (millions
        // of lines on a large store, #3928) and never advances anything, so
        // stop this run here. Nothing is lost: the rows keep their pending
        // marks or stay above the watermark and the next backfill retries them.
        if (consecutiveFailures >= this.MAX_CONSECUTIVE_BATCH_FAILURES) {
          logger.error('CHROMA_SYNC', 'Backfill stopped after repeated batch failures', {
            project: backfillProject,
            kind,
            consecutiveFailures,
            lastRowId: row.id,
            remainingRows: rowsWithDocs.length - rowIndex - 1
          });
          return { writtenDocs, emptyRows, abortReason: 'write_failures', writeFailures: hadWriteFailures };
        }
        continue;
      }

      const droppedDuringRow = collectionDropped();
      if (droppedDuringRow) {
        return droppedDuringRow;
      }
      ChromaSyncState.clearPending(backfillProject, kind, [row.id]);
      ChromaSyncState.bump(backfillProject, kind, row.id);
    }

    // A run that walked every row but lost some to isolated write failures is
    // not a completed backfill: the failed rows stay pending for the next run,
    // but a document is still missing now. Report that without aborting the
    // pipeline, so the remaining kinds still run (#4264).
    return { writtenDocs, emptyRows, abortReason: null, writeFailures: hadWriteFailures };
  }

  /**
   * One-time recovery (#4069). Before title documents existed, an observation
   * with no narrative, text or facts produced no document while the watermark
   * still moved past it, so it is neither indexed nor pending. Mark every such
   * row at or below the watermark pending, once per project, so this backfill
   * indexes its title. Rows above the watermark are picked up anyway.
   */
  private requeueTitleOnlyObservationsOnce(db: SessionStore, project: string, watermark: number): void {
    if (ChromaSyncState.isTitleOnlyRequeued(project)) {
      return;
    }
    const candidates = db.db.prepare(`
      SELECT id, title, subtitle, facts
      FROM observations
      WHERE project = ? AND id <= ?
        AND COALESCE(narrative, '') = '' AND COALESCE(text, '') = ''
    `).all(project, watermark) as Array<Pick<StoredObservation, 'id' | 'title' | 'subtitle' | 'facts'>>;
    const titleOnlyIds = candidates
      .filter(row => observationTitleText(row) && parseStringListField(row.facts, 'facts', row.id).length === 0)
      .map(row => row.id);

    ChromaSyncState.markPending(project, 'observations', titleOnlyIds);
    ChromaSyncState.markTitleOnlyRequeued(project);
    if (titleOnlyIds.length > 0) {
      logger.info('CHROMA_SYNC', 'Requeued title-only observations that earlier versions never indexed', {
        project,
        count: titleOnlyIds.length
      });
    }
  }

  private async backfillObservations(
    db: SessionStore,
    backfillProject: string,
    watermark: number
  ): Promise<BackfillKindResult> {
    this.requeueTitleOnlyObservationsOnce(db, backfillProject, watermark);
    const pendingIds = ChromaSyncState.getPending(backfillProject, 'observations');
    const observations = db.db.prepare(`
      SELECT
        o.*,
        COALESCE(NULLIF(s.platform_source, ''), 'claude') as platform_source
      FROM observations o
      LEFT JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id
      WHERE o.project = ? AND o.id > ?
      ORDER BY o.id ASC
    `).all(backfillProject, watermark) as StoredObservation[];
    let pendingRows: StoredObservation[] = [];
    if (pendingIds.length > 0) {
      const placeholders = pendingIds.map(() => '?').join(', ');
      pendingRows = db.db.prepare(`
        SELECT
          o.*,
          COALESCE(NULLIF(s.platform_source, ''), 'claude') as platform_source
        FROM observations o
        LEFT JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id
        WHERE o.project = ? AND o.id IN (${placeholders})
        ORDER BY o.id ASC
      `).all(backfillProject, ...pendingIds) as StoredObservation[];
      const foundPendingIds = new Set(pendingRows.map(row => row.id));
      const missingPendingIds = pendingIds.filter(id => !foundPendingIds.has(id));
      if (missingPendingIds.length > 0) {
        ChromaSyncState.clearPending(backfillProject, 'observations', missingPendingIds);
      }
    }
    const rows = this.mergeRowsById(observations, pendingRows);

    if (rows.length === 0) {
      return { writtenDocs: 0, emptyRows: 0, abortReason: null, writeFailures: false };
    }

    const totalObsCount = db.db.prepare(`
      SELECT COUNT(*) as count FROM observations WHERE project = ?
    `).get(backfillProject) as { count: number };

    logger.info('CHROMA_SYNC', 'Backfilling observations', {
      project: backfillProject,
      missing: rows.length,
      pending: pendingIds.length,
      watermark,
      total: totalObsCount.count
    });

    return this.backfillKind(rows, obs => this.formatObservationDocs(obs), 'observations', backfillProject);
  }

  private async backfillSummaries(
    db: SessionStore,
    backfillProject: string,
    watermark: number
  ): Promise<BackfillKindResult> {
    const pendingIds = ChromaSyncState.getPending(backfillProject, 'summaries');
    const summaries = db.db.prepare(`
      SELECT
        ss.*,
        COALESCE(NULLIF(s.platform_source, ''), 'claude') as platform_source
      FROM session_summaries ss
      LEFT JOIN sdk_sessions s ON s.memory_session_id = ss.memory_session_id
      WHERE ss.project = ? AND ss.id > ?
      ORDER BY ss.id ASC
    `).all(backfillProject, watermark) as StoredSummary[];
    let pendingRows: StoredSummary[] = [];
    if (pendingIds.length > 0) {
      const placeholders = pendingIds.map(() => '?').join(', ');
      pendingRows = db.db.prepare(`
        SELECT
          ss.*,
          COALESCE(NULLIF(s.platform_source, ''), 'claude') as platform_source
        FROM session_summaries ss
        LEFT JOIN sdk_sessions s ON s.memory_session_id = ss.memory_session_id
        WHERE ss.project = ? AND ss.id IN (${placeholders})
        ORDER BY ss.id ASC
      `).all(backfillProject, ...pendingIds) as StoredSummary[];
      const foundPendingIds = new Set(pendingRows.map(row => row.id));
      const missingPendingIds = pendingIds.filter(id => !foundPendingIds.has(id));
      if (missingPendingIds.length > 0) {
        ChromaSyncState.clearPending(backfillProject, 'summaries', missingPendingIds);
      }
    }
    const rows = this.mergeRowsById(summaries, pendingRows);

    if (rows.length === 0) {
      return { writtenDocs: 0, emptyRows: 0, abortReason: null, writeFailures: false };
    }

    const totalSummaryCount = db.db.prepare(`
      SELECT COUNT(*) as count FROM session_summaries WHERE project = ?
    `).get(backfillProject) as { count: number };

    logger.info('CHROMA_SYNC', 'Backfilling summaries', {
      project: backfillProject,
      missing: rows.length,
      pending: pendingIds.length,
      watermark,
      total: totalSummaryCount.count
    });

    return this.backfillKind(rows, summary => this.formatSummaryDocs(summary), 'summaries', backfillProject);
  }

  private async backfillPrompts(
    db: SessionStore,
    backfillProject: string,
    watermark: number
  ): Promise<BackfillKindResult> {
    const pendingIds = ChromaSyncState.getPending(backfillProject, 'prompts');
    const prompts = db.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.memory_session_id,
        COALESCE(NULLIF(s.platform_source, ''), 'claude') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      WHERE s.project = ? AND up.id > ?
      ORDER BY up.id ASC
    `).all(backfillProject, watermark) as StoredUserPrompt[];
    let pendingRows: StoredUserPrompt[] = [];
    if (pendingIds.length > 0) {
      const placeholders = pendingIds.map(() => '?').join(', ');
      pendingRows = db.db.prepare(`
        SELECT
          up.*,
          s.project,
          s.memory_session_id,
          COALESCE(NULLIF(s.platform_source, ''), 'claude') as platform_source
        FROM user_prompts up
        JOIN sdk_sessions s ON up.session_db_id = s.id
        WHERE s.project = ? AND up.id IN (${placeholders})
        ORDER BY up.id ASC
      `).all(backfillProject, ...pendingIds) as StoredUserPrompt[];
      const foundPendingIds = new Set(pendingRows.map(row => row.id));
      const missingPendingIds = pendingIds.filter(id => !foundPendingIds.has(id));
      if (missingPendingIds.length > 0) {
        ChromaSyncState.clearPending(backfillProject, 'prompts', missingPendingIds);
      }
    }
    const rows = this.mergeRowsById(prompts, pendingRows);

    if (rows.length === 0) {
      return { writtenDocs: 0, emptyRows: 0, abortReason: null, writeFailures: false };
    }

    const totalPromptCount = db.db.prepare(`
      SELECT COUNT(*) as count
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      WHERE s.project = ?
    `).get(backfillProject) as { count: number };

    logger.info('CHROMA_SYNC', 'Backfilling user prompts', {
      project: backfillProject,
      missing: rows.length,
      pending: pendingIds.length,
      watermark,
      total: totalPromptCount.count
    });

    return this.backfillKind(rows, prompt => [this.formatUserPromptDoc(prompt)], 'prompts', backfillProject);
  }

  async queryChroma(
    query: string,
    limit: number,
    whereFilter?: Record<string, any>,
    progress?: ChromaQueryProgress
  ): Promise<{ ids: number[]; distances: number[]; metadatas: any[] }> {
    if (progress) progress.exhausted = false;
    await this.ensureCollectionExists();

    let results: any;
    const runQuery = async (nResults: number, where: Record<string, any> | undefined, include: string[]) => {
      const chromaMcp = ChromaMcpManager.getInstance();
      return await chromaMcp.callTool('chroma_query_documents', {
        collection_name: this.collectionName,
        query_texts: [query],
        n_results: nResults,
        ...(where && { where }),
        include
      });
    };

    try {
      // Fast path: keep a non-selective filter out of chroma by over-fetching
      // unfiltered and applying the clause here (see CHROMA_OVERFETCH_FACTOR).
      const predicate = whereFilter && limit > 0 ? buildClientSidePredicate(whereFilter) : null;
      const filterKey = whereFilter ? JSON.stringify(whereFilter) : '';
      const knownSurvivors = this.selectiveFilters.get(filterKey);
      if (predicate && (knownSurvivors === undefined || knownSurvivors >= limit)) {
        const overfetch = Math.min(
          Math.max(limit * CHROMA_OVERFETCH_FACTOR, limit),
          CHROMA_OVERFETCH_CAP
        );
        // Only ids, metadatas and distances are read below, so the (up to
        // CHROMA_OVERFETCH_CAP) document texts are not worth shipping over MCP.
        const raw: any = await runQuery(overfetch, undefined, ['metadatas', 'distances']);
        const rawIds = raw?.ids?.[0] || [];
        const rawMetadatas = raw?.metadatas?.[0] || [];
        const rawDistances = raw?.distances?.[0] || [];

        const keptIds: string[] = [];
        const keptMetadatas: any[] = [];
        const keptDistances: number[] = [];
        for (let i = 0; i < rawIds.length; i++) {
          if (!predicate(rawMetadatas[i] ?? {})) continue;
          keptIds.push(rawIds[i]);
          keptMetadatas.push(rawMetadatas[i]);
          keptDistances.push(rawDistances[i]);
        }

        const filtered = this.deduplicateQueryResults({
          ids: [keptIds], metadatas: [keptMetadatas], distances: [keptDistances]
        });

        // Enough survivors means the filter was not selective and the fast path
        // is sound. Too few means it WAS selective -- the case SearchManager
        // pushes into chroma so small projects are not crowded out of the top-N
        // -- and chroma handles a selective filter cheaply. So fall through.
        if (filtered.ids.length >= limit) {
          this.selectiveFilters.delete(filterKey);
          // A full unique-row window can still hide later rows, even when the
          // over-fetch reached the end of the raw document list.
          if (progress) progress.exhausted = rawIds.length < overfetch && filtered.ids.length <= limit;
          return {
            ids: filtered.ids.slice(0, limit),
            distances: filtered.distances.slice(0, limit),
            metadatas: filtered.metadatas.slice(0, limit)
          };
        }

        if (this.selectiveFilters.size >= ChromaSync.SELECTIVE_FILTER_MEMO_CAP) {
          this.selectiveFilters.clear();
        }
        this.selectiveFilters.set(filterKey, filtered.ids.length);
      }

      results = await runQuery(limit, whereFilter, ['documents', 'metadatas', 'distances']);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      const isConnectionError =
        errorMessage.includes('ECONNREFUSED') || // [ANTI-PATTERN IGNORED]: ChromaMcpManager.callTool re-wraps transport failures as plain Errors, so the Node error code only survives in the message text; the full error object is logged below.
        errorMessage.includes('ENOTFOUND') || // [ANTI-PATTERN IGNORED]: same MCP transport re-wrapping as above; no structured code field is available on the re-wrapped error.
        errorMessage.includes('fetch failed') || 
        errorMessage.includes('subprocess closed') || 
        errorMessage.includes('timed out'); 

      if (isConnectionError) {
        this.collectionEnsuredGeneration = -1;
        logger.error('CHROMA_SYNC', 'Connection lost during query',
          { project: this.project, query }, error as Error);
        throw new Error(`Chroma query failed - connection lost: ${errorMessage}`);
      }

      logger.error('CHROMA_SYNC', 'Query failed', { project: this.project, query }, error as Error);
      throw error;
    }

    // Use raw fragments, not deduplicated row IDs: one observation can occupy
    // many document slots, so a short unique-ID list does not imply exhaustion.
    if (progress) progress.exhausted = (results?.ids?.[0]?.length ?? 0) < limit;
    return this.deduplicateQueryResults(results);
  }

  private deduplicateQueryResults(results: any): { ids: number[]; distances: number[]; metadatas: any[] } {
    const ids: number[] = [];
    const seen = new Set<string>();
    const docIds = results?.ids?.[0] || [];
    const rawMetadatas = results?.metadatas?.[0] || [];
    const rawDistances = results?.distances?.[0] || [];

    const metadatas: any[] = [];
    const distances: number[] = [];

    for (let i = 0; i < docIds.length; i++) {
      const docId = docIds[i];
      const obsMatch = docId.match(/obs_(\d+)_/);
      const summaryMatch = docId.match(/summary_(\d+)_/);
      const promptMatch = docId.match(/prompt_(\d+)/);

      let sqliteId: number | null = null;
      let entityType: string | null = null;
      if (obsMatch) {
        sqliteId = parseInt(obsMatch[1], 10);
        entityType = 'observation';
      } else if (summaryMatch) {
        sqliteId = parseInt(summaryMatch[1], 10);
        entityType = 'session_summary';
      } else if (promptMatch) {
        sqliteId = parseInt(promptMatch[1], 10);
        entityType = 'user_prompt';
      }

      if (sqliteId !== null && entityType) {
        const dedupeKey = `${entityType}:${sqliteId}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        ids.push(sqliteId);
        metadatas.push(rawMetadatas[i] ?? null);
        distances.push(rawDistances[i] ?? 0);
      }
    }

    return { ids, distances, metadatas };
  }

  /** Maximum number of concurrent project backfills to run at once. */
  private static readonly BACKFILL_CONCURRENCY_LIMIT = 3;

  /** Guard flag to prevent overlapping backfill runs from fire-and-forget callers. */
  private static backfillInProgress = false;

  /**
   * Backfill every project that has indexable rows in SQLite (observations,
   * summaries or session-joined prompts) but may be missing from Chroma.
   * Uses a single shared ChromaSync('claude-mem') instance and Chroma connection.
   * Per-project scoping is passed as a parameter to ensureBackfilled(), avoiding
   * instance state mutation. All documents land in the cm__claude-mem collection
   * with project scoped via metadata, matching how DatabaseManager and SearchManager operate.
   * Designed to be called fire-and-forget on worker startup.
   *
   * Concurrency: processes at most BACKFILL_CONCURRENCY_LIMIT projects in parallel
   * to bound CPU and memory pressure from concurrent Chroma embedding operations.
   * A re-entrant guard prevents overlapping backfill runs from accumulating.
   *
   * Resolves true only when every project's backfill finished; false when a
   * project failed or stopped early, when the sweep stopped for a worker
   * shutdown, or when another sweep was already running.
   */
  static async backfillAllProjects(store: SessionStore): Promise<boolean> {
    if (ChromaSync.backfillInProgress) {
      logger.info('CHROMA_SYNC', 'Backfill already in progress, skipping duplicate run');
      return false;
    }

    ChromaSync.backfillInProgress = true;
    try {
      for (;;) {
        const generation = ChromaSync.collectionGeneration;
        const completed = await ChromaSync.sweepAllProjects(store, generation);
        if (ChromaSync.collectionGeneration === generation) {
          return completed;
        }
        // A corrupt collection was dropped during this sweep (#3202) and took
        // its work with it, so start over and rebuild every project. Each
        // collection is dropped at most once per process, so this is bounded.
        logger.info('CHROMA_SYNC', 'Collection dropped during the backfill sweep; rebuilding every project');
      }
    } finally {
      ChromaSync.backfillInProgress = false;
    }
  }

  private static async sweepAllProjects(store: SessionStore, generation: number): Promise<boolean> {
    const sync = new ChromaSync('claude-mem');
    const completed: string[] = [];
    const incomplete: string[] = [];

    // Enumerate the union of projects across all three indexed tables
    // (#4069): a project with only summaries or session-joined prompts —
    // or an empty-string project — never appeared in the old
    // observations-only list, so its rows were never backfill candidates.
    const projects = store.db.prepare(`
      SELECT DISTINCT project FROM (
        SELECT project FROM observations WHERE project IS NOT NULL
        UNION
        SELECT project FROM session_summaries WHERE project IS NOT NULL
        UNION
        SELECT s.project FROM user_prompts up
        JOIN sdk_sessions s ON up.session_db_id = s.id
        WHERE s.project IS NOT NULL
      )
    `).all() as { project: string }[];

    logger.info('CHROMA_SYNC', `Backfill check for ${projects.length} projects`);

    if (!ChromaSyncState.exists()) {
      logger.info('CHROMA_SYNC', 'Watermark cache missing — bootstrapping from Chroma (one-time)');
      for (const { project } of projects) {
        if (shutdownBegan()) {
          logger.info('CHROMA_SYNC', 'Bootstrap stopped: worker shutdown began', { project });
          return false;
        }
        try {
          await sync.bootstrapWatermarksFromChroma(project, store);
        } catch (error) {
          if (shutdownBegan()) {
            logger.info('CHROMA_SYNC', 'Bootstrap stopped: worker shutdown began', { project });
            return false;
          }
          logger.error('CHROMA_SYNC', `Bootstrap failed for project: ${project}`,
            {}, error instanceof Error ? error : new Error(String(error)));
        }
      }
      logger.info('CHROMA_SYNC', 'Bootstrap complete — incremental backfills will use watermarks');
    }

    // Process projects in chunks of BACKFILL_CONCURRENCY_LIMIT to bound
    // CPU/memory pressure from concurrent Chroma embedding operations.
    // Each chunk runs its projects in parallel; we wait for the entire chunk
    // before starting the next one. Simple and predictable — no semaphore
    // overhead, no unbounded fan-out.
    const concurrency = ChromaSync.BACKFILL_CONCURRENCY_LIMIT;
    for (let i = 0; i < projects.length; i += concurrency) {
      if (shutdownBegan()) {
        logger.info('CHROMA_SYNC', 'Backfill sweep stopped: worker shutdown began', {
          remainingProjects: projects.length - i
        });
        return false;
      }
      if (ChromaSync.collectionGeneration !== generation) {
        return false;
      }

      const chunk = projects.slice(i, i + concurrency);
      const chunkResults = await Promise.allSettled(
        chunk.map(({ project }) => sync.ensureBackfilled(project, store))
      );

      for (let j = 0; j < chunkResults.length; j++) {
        const project = chunk[j].project;
        const result = chunkResults[j];
        if (result.status === 'rejected') {
          incomplete.push(project);
          const error = result.reason;
          if (error instanceof Error) {
            logger.error('CHROMA_SYNC', `Backfill failed for project: ${project}`, {}, error);
          } else {
            logger.error('CHROMA_SYNC', `Backfill failed for project: ${project}`, { error: String(error) });
          }
          // Continue to next chunk — don't let one failure stop others
        } else if (result.value !== 'completed') {
          // backfillKind already logged why it stopped; record the project
          // so the sweep does not claim it finished (#4069).
          incomplete.push(project);
        } else {
          completed.push(project);
        }
      }
    }

    if (incomplete.length > 0) {
      logger.warn('CHROMA_SYNC', `Backfill sweep finished with ${incomplete.length} incomplete project(s)`, {
        incomplete,
        completed: completed.length
      });
    }
    return incomplete.length === 0;
  }

  async updateMergedIntoProject(
    targets: MergedIntoProjectTarget[],
    mergedIntoProject: string
  ): Promise<void> {
    if (targets.length === 0) return;

    await this.ensureCollectionExists();
    const chromaMcp = ChromaMcpManager.getInstance();

    let totalPatched = 0;

    for (const docType of ['observation', 'session_summary'] as const) {
      const sqliteIds = targets
        .filter(target => target.docType === docType)
        .map(target => target.sqliteId);

      for (let i = 0; i < sqliteIds.length; i += this.BATCH_SIZE) {
        const idBatch = sqliteIds.slice(i, i + this.BATCH_SIZE);

        const existing = await chromaMcp.callTool('chroma_get_documents', {
          collection_name: this.collectionName,
          where: {
            $and: [
              { doc_type: docType },
              { sqlite_id: { $in: idBatch } }
            ]
          },
          include: ['metadatas']
        }) as { ids?: string[]; metadatas?: Array<Record<string, any> | null> };

        const docIds: string[] = existing?.ids ?? [];
        if (docIds.length === 0) continue;

        const metadatas = (existing?.metadatas ?? []).map(m => {
          const merged: Record<string, any> = {
            ...(m ?? {}),
            merged_into_project: mergedIntoProject
          };
          return Object.fromEntries(
            Object.entries(merged).filter(
              ([, v]) => v !== null && v !== undefined && v !== ''
            )
          );
        });

        await chromaMcp.callTool('chroma_update_documents', {
          collection_name: this.collectionName,
          ids: docIds,
          metadatas
        });
        totalPatched += docIds.length;
      }
    }

    logger.info('CHROMA_SYNC', 'merged_into_project metadata patched', {
      collection: this.collectionName,
      mergedIntoProject,
      sqliteIdCount: targets.length,
      chromaDocsPatched: totalPatched
    });
  }
}
