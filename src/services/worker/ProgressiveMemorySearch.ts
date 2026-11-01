import { ProgressiveSearch, projectMemoryContent, type ProgressiveSearchInput, type MemoryIndexRow, type MemoryDetail } from '../../shared/progressive-search.js';
import type { SearchManager } from './SearchManager.js';
import type { SessionStore } from '../sqlite/SessionStore.js';
import { SEARCH_CONSTANTS } from './search/types.js';
import { logger } from '../../utils/logger.js';

type StoredRow = {
  id: number; project: string; title?: string | null; request?: string | null;
  prompt_text?: string; type?: string; created_at_epoch?: number;
  subtitle?: string | null; narrative?: string | null; facts?: string | null; concepts?: string | null;
  files_read?: string | null; files_modified?: string | null; investigated?: string | null; learned?: string | null;
  completed?: string | null; next_steps?: string | null; notes?: string | null;
};

function indexRow(row: StoredRow, kind: MemoryIndexRow['kind']): MemoryIndexRow {
  return {
    id: kind === 'summary' ? `S${row.id}` : kind === 'prompt' ? `P${row.id}` : String(row.id),
    kind,
    project: row.project,
    title: row.title ?? row.request ?? row.prompt_text?.slice(0, 160) ?? 'Untitled',
    createdAt: row.created_at_epoch ?? null,
    type: row.type ?? null,
  };
}

/** The worker runs the same dumb_search pipeline as remote MCP. */
export class ProgressiveMemorySearch {
  constructor(private readonly searchManager: SearchManager, private readonly store: SessionStore) {}

  async run(input: ProgressiveSearchInput, projects?: string[] | string) {
    const result = await new ProgressiveSearch({
      search: async ({ query, project, limit }) => {
        // Hydrate the backend's whole first candidate window, not just `limit`
        // rows: the title rerank below must see a weaker-ranked exact match
        // before the index is cut to `limit` (#4865).
        const candidateLimit = Math.max(limit, SEARCH_CONSTANTS.CHROMA_BATCH_SIZE);
        const result = await this.searchManager.search({ query, project, projects, limit: candidateLimit, format: 'json' });
        const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];
        const categories: Array<[MemoryIndexRow['kind'], StoredRow[]]> = [
          ['observation', result.observations], ['summary', result.sessions], ['prompt', result.prompts],
        ];
        // The underlying search has a separate per-kind budget. Merge compact
        // candidates by title evidence, then round-robin their per-kind ranks;
        // a full observation page must never hide a stronger summary/prompt.
        return categories.flatMap(([kind, rows]) => rows.map((stored, position) => {
          const row = indexRow(stored, kind);
          const titleWords = new Set(row.title.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
          return { row, position, score: terms.filter(term => titleWords.has(term)).length };
        })).sort((a, b) => b.score - a.score || a.position - b.position)
          .slice(0, limit).map(candidate => candidate.row);
      },
      timeline: async ({ anchor, depthBefore, depthAfter }) => this.timeline(anchor, depthBefore, depthAfter),
      fetch: async refs => this.fetch(refs),
    }).run(input);
    logger.debug('SEARCH', 'Dumb search completed', {
      step: result.step, indexCount: result.index.length, detailCount: result.observations.length,
    });
    return result;
  }

  private timeline(anchor: MemoryIndexRow, before: number, after: number): MemoryIndexRow[] {
    // Use the matched row's stored project. Search can span parent/re-keyed projects;
    // repeating the requested checkout key here would silently lose the anchor.
    const epoch = anchor.createdAt;
    if (epoch === null) return [anchor];
    const numericId = Number(anchor.id.replace(/^[SP]/, ''));
    // Each arm is a subquery so its boundary predicate, ORDER BY and LIMIT stay
    // inside it: the arm then reads its project index in order and stops at
    // `limit` instead of materialising every row of the project. SQLite rejects
    // an ORDER BY placed directly between UNION ALL arms, hence the wrapper.
    const query = (comparison: '<' | '>', order: 'ASC' | 'DESC', limit: number) => this.store.db.prepare(`
      WITH memory_index AS (
        SELECT * FROM (
          SELECT id, project, title, type, created_at_epoch, 'observation' AS kind FROM observations
          WHERE project COLLATE NOCASE = ? AND (created_at_epoch, 'observation', id) ${comparison} (?, ?, ?)
          ORDER BY created_at_epoch ${order}, id ${order} LIMIT ?
        )
        UNION ALL
        SELECT * FROM (
          SELECT id, project, request AS title, NULL AS type, created_at_epoch, 'summary' AS kind FROM session_summaries
          WHERE project COLLATE NOCASE = ? AND (created_at_epoch, 'summary', id) ${comparison} (?, ?, ?)
          ORDER BY created_at_epoch ${order}, id ${order} LIMIT ?
        )
        UNION ALL
        SELECT * FROM (
          SELECT up.id, s.project, substr(up.prompt_text, 1, 160) AS title, NULL AS type, up.created_at_epoch, 'prompt' AS kind
          FROM user_prompts up JOIN sdk_sessions s ON up.session_db_id = s.id
          WHERE s.project COLLATE NOCASE = ? AND (up.created_at_epoch, 'prompt', up.id) ${comparison} (?, ?, ?)
          ORDER BY up.created_at_epoch ${order}, up.id ${order} LIMIT ?
        )
      )
      SELECT * FROM memory_index
      ORDER BY created_at_epoch ${order}, kind ${order}, id ${order} LIMIT ?
    `).all(
      anchor.project, epoch, anchor.kind, numericId, limit,
      anchor.project, epoch, anchor.kind, numericId, limit,
      anchor.project, epoch, anchor.kind, numericId, limit,
      limit,
    ) as Array<StoredRow & { kind: MemoryIndexRow['kind'] }>;
    return [
      ...query('<', 'DESC', before).reverse().map(row => indexRow(row, row.kind)),
      anchor,
      ...query('>', 'ASC', after).map(row => indexRow(row, row.kind)),
    ];
  }

  private fetch(refs: MemoryIndexRow[]): MemoryDetail[] {
    const observationIds = refs.filter(row => row.kind === 'observation').map(row => Number(row.id));
    const summaryIds = refs.filter(row => row.kind === 'summary').map(row => Number(row.id.slice(1)));
    const observations = observationIds.length ? this.store.getObservationsByIds(observationIds, { orderBy: 'relevance', limit: 5 }) : [];
    const summaries = summaryIds.length ? this.store.getSessionSummariesByIds(summaryIds, { orderBy: 'date_desc', limit: 5 }) : [];
    const found = new Map<string, StoredRow>([
      ...observations.map(row => [String(row.id), row] as [string, StoredRow]),
      ...summaries.map(row => [`S${row.id}`, row] as [string, StoredRow]),
    ]);
    return refs.flatMap(ref => {
      const row = found.get(ref.id);
      // The token authorizes a row, not any future object reusing its ID.
      if (!row || row.project !== ref.project) return [];
      const projected = projectMemoryContent(row);
      return [{ ...ref, content: projected.text, truncated: projected.truncated }];
    });
  }
}
