import type { ParsedObservation, ParsedSummary } from '../../sdk/parser.js';
import type { VectorDoc } from './types.js';
import { VectorIndex } from './VectorIndex.js';
import type { VectorDocKind } from './types.js';
import { logger } from '../../utils/logger.js';

/**
 * What syncObservation accepts.
 *
 * ParsedObservation is the v8+ shape and has no `text`; the BASE observations
 * column does, and it is the ONLY populated content column on every row
 * captured before v8 (schema v8 adds narrative/facts by bare ALTER TABLE and
 * backfills neither). A caller replaying a stored row therefore has a `text`
 * to hand even though the parser never produces one, and ChromaSync rendered
 * exactly that as obs_<id>_text. Accepting it here keeps the document families
 * this class emits equal to the ones it replaces.
 */
export type SyncableObservation = ParsedObservation & { text?: string | null };

/**
 * Write-path shim over VectorIndex.
 *
 * Signature-compatible with the ChromaSync methods it replaces, so the six
 * call sites reached through DatabaseManager.getChromaSync() do not change
 * shape. What changes is underneath:
 *
 *  - No watermark bump. ChromaSync had to advance a watermark file only on a
 *    confirmed full write, because a partial write to a separate store would
 *    otherwise be skipped forever by the next backfill (PR #2282). Writing
 *    into the same database removes the failure it was guarding: "which rows
 *    have no vector" is now a question the database itself answers, so a
 *    partial write is simply re-selected next pass. The watermark file, and
 *    the "reset chroma-sync-state.json or the re-embed is suppressed" recovery
 *    step from #3012, both stop existing.
 *
 *  - No duplicated metadata. ChromaSync copied project, merged_into_project,
 *    platform_source, concepts and file lists onto every document, which is
 *    why they could drift out of sync with SQLite. They now live only in the
 *    base tables and are reached by JOIN at query time.
 *
 * Document ids stay byte-identical to the ones ChromaSync wrote — the three
 * observation forms (obs_<id>_narrative, obs_<id>_text, obs_<id>_fact_<n>)
 * plus summary_<id>_<field> and prompt_<id>. Nothing outside this package
 * reads them today; the point is that this class and VectorBackfill mint the
 * same id for the same document, and that the scheme a future reader would
 * expect is the one it already knows.
 */
export class VectorSync {
  constructor(private readonly index: VectorIndex) {}

  /** The typed query path, for callers that don't need the Chroma shape. */
  getIndex(): VectorIndex {
    return this.index;
  }

  /** Ordering matches ChromaSync.formatObservationDocs: narrative, text, facts. */
  private observationDocs(observationId: number, obs: SyncableObservation): VectorDoc[] {
    const docs: VectorDoc[] = [];
    if (obs.narrative) {
      docs.push({
        docId: `obs_${observationId}_narrative`,
        sqliteId: observationId,
        fieldType: 'narrative',
        factIndex: null,
        text: obs.narrative,
      });
    }
    if (obs.text) {
      docs.push({
        docId: `obs_${observationId}_text`,
        sqliteId: observationId,
        fieldType: 'text',
        factIndex: null,
        text: obs.text,
      });
    }
    obs.facts.forEach((fact, index) => {
      docs.push({
        docId: `obs_${observationId}_fact_${index}`,
        sqliteId: observationId,
        fieldType: 'fact',
        factIndex: index,
        text: fact,
      });
    });
    return docs;
  }

  async syncObservation(
    observationId: number,
    _memorySessionId: string,
    project: string,
    obs: SyncableObservation,
    _promptNumber: number,
    _createdAtEpoch: number,
    _platformSource?: string,
  ): Promise<void> {
    const docs = this.observationDocs(observationId, obs);
    if (docs.length === 0) return;
    const embedded = await this.index.upsert('observation', docs);
    logger.info('VECTOR_SYNC', 'Indexed observation', {
      observationId, project, documents: docs.length, embedded,
    });
  }

  async syncUserPrompt(
    promptId: number,
    _memorySessionId: string,
    project: string,
    promptText: string,
    _promptNumber: number,
    _createdAtEpoch: number,
    _platformSource?: string,
  ): Promise<void> {
    if (!promptText) return;
    const embedded = await this.index.upsert('prompt', [{
      docId: `prompt_${promptId}`,
      sqliteId: promptId,
      fieldType: 'prompt_text',
      factIndex: null,
      text: promptText,
    }]);
    logger.info('VECTOR_SYNC', 'Indexed prompt', { promptId, project, embedded });
  }

  async syncSummary(
    summaryId: number,
    _memorySessionId: string,
    project: string,
    summary: ParsedSummary,
    _promptNumber: number,
    _createdAtEpoch: number,
    _platformSource?: string,
  ): Promise<void> {
    // Same field set ChromaSync rendered, one document per populated field.
    const fields: Array<[string, string | null | undefined]> = [
      ['request', summary.request],
      ['investigated', summary.investigated],
      ['learned', summary.learned],
      ['completed', summary.completed],
      ['next_steps', summary.next_steps],
      ['notes', summary.notes],
    ];
    const docs: VectorDoc[] = fields
      .filter(([, value]) => Boolean(value))
      .map(([field, value]) => ({
        docId: `summary_${summaryId}_${field}`,
        sqliteId: summaryId,
        fieldType: field,
        factIndex: null,
        text: value as string,
      }));
    if (docs.length === 0) return;
    const embedded = await this.index.upsert('summary', docs);
    logger.info('VECTOR_SYNC', 'Indexed summary', {
      summaryId, project, documents: docs.length, embedded,
    });
  }

  /**
   * Chroma-shaped query, kept so SearchManager and the strategies below it do
   * not change. Signature and return shape match ChromaSync.queryChroma.
   *
   * Only `created_at_epoch` is read off the returned metadata (recency
   * filtering, SearchManager:117 and :403), so that is all this supplies —
   * and it comes from the parent row by JOIN rather than from a denormalised
   * copy, which is precisely the duplication that used to drift.
   *
   * `distance` is emitted as 1 - cosine so smaller stays nearer, matching what
   * the previous caller expected.
   */
  async queryChroma(
    query: string,
    limit: number,
    whereFilter?: Record<string, any>,
  ): Promise<{ ids: number[]; distances: number[]; metadatas: any[] }> {
    const { kinds, project, platformSource } = translateWhereFilter(whereFilter);
    const hits = await this.index.query({ text: query, kinds, project, platformSource, limit });
    return {
      ids: hits.map((h) => h.sqliteId),
      distances: hits.map((h) => 1 - h.score),
      metadatas: hits.map((h) => ({
        created_at_epoch: h.createdAtEpoch,
        doc_type: KIND_TO_DOC_TYPE[h.kind],
      })),
    };
  }
}

const KIND_TO_DOC_TYPE: Record<VectorDocKind, string> = {
  observation: 'observation',
  summary: 'session_summary',
  prompt: 'user_prompt',
};

/**
 * Chroma doc_type (what the semantic layer's filters and metadata speak) to the
 * vector kind the index is keyed by. Exported because SearchManager's readiness
 * gate asks the same question; a second copy of this mapping is a thing that can
 * drift.
 */
export const DOC_TYPE_TO_KIND: Record<string, VectorDocKind> = {
  observation: 'observation',
  session_summary: 'summary',
  user_prompt: 'prompt',
};

/**
 * Unpacks the Chroma-shaped filter VectorSearchStrategy.buildWhereFilter still
 * produces: a bare object, or {$and: [...]}, whose clauses are {doc_type},
 * {platform_source}, or {$or: [{project}, {merged_into_project}]}.
 */
function translateWhereFilter(filter?: Record<string, any>): {
  kinds: VectorDocKind[];
  project?: string;
  platformSource?: string;
} {
  const kinds: VectorDocKind[] = [];
  let project: string | undefined;
  let platformSource: string | undefined;

  const clauses: Record<string, any>[] = !filter
    ? []
    : Array.isArray(filter.$and)
      ? filter.$and
      : [filter];

  for (const clause of clauses) {
    if (typeof clause?.doc_type === 'string') {
      const kind = DOC_TYPE_TO_KIND[clause.doc_type];
      if (kind) kinds.push(kind);
    }
    if (typeof clause?.platform_source === 'string') {
      platformSource = clause.platform_source;
    }
    if (typeof clause?.project === 'string') {
      project = clause.project;
    }
    if (Array.isArray(clause?.$or)) {
      for (const alt of clause.$or) {
        if (typeof alt?.project === 'string') project = alt.project;
      }
    }
  }

  // No doc_type clause means "all kinds", which is what an absent filter meant.
  return {
    kinds: kinds.length > 0 ? kinds : ['observation', 'summary', 'prompt'],
    project,
    platformSource,
  };
}
