import type { ParsedObservation, ParsedSummary } from '../../sdk/parser.js';
import type { VectorDoc } from './types.js';
import { VectorIndex } from './VectorIndex.js';
import { logger } from '../../utils/logger.js';

/**
 * Write-path shim over VectorIndex.
 *
 * Signature-compatible with the ChromaSync methods it replaces, so the six
 * call sites reached through DatabaseManager.getChromaSync() do not change
 * shape. What changes is underneath:
 *
 *  - No watermark bump. ChromaSync had to advance ChromaSyncState only on a
 *    confirmed full write, because a partial write to a separate store would
 *    otherwise be skipped forever by the next backfill (PR #2282). Writing
 *    into the same database removes the failure it was guarding: the vector
 *    lands in the caller's transaction or nothing does. The watermark file,
 *    and the "reset chroma-sync-state.json or the re-embed is suppressed"
 *    recovery step from #3012, both stop existing.
 *
 *  - No duplicated metadata. ChromaSync copied project, merged_into_project,
 *    platform_source, concepts and file lists onto every document, which is
 *    why they could drift out of sync with SQLite. They now live only in the
 *    base tables and are reached by JOIN at query time.
 *
 * Document ids stay byte-identical (obs_<id>_narrative / _text / _fact_<n>)
 * so anything holding a reference to one still resolves.
 */
export class VectorSync {
  constructor(private readonly index: VectorIndex) {}

  private observationDocs(observationId: number, obs: ParsedObservation): VectorDoc[] {
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
    obs: ParsedObservation,
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
        docId: `sum_${summaryId}_${field}`,
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
}
