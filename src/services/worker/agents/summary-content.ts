import { summaryFieldsHaveText } from '../../../sdk/parser.js';

/**
 * Storage eligibility, not XML validity or a semantic quality score. Sparse
 * summaries (including notes-only replies) remain useful. A request title or
 * future plan alone says nothing about the progress being recorded.
 * The caller handles skip_summary separately. Inspect the original XML so
 * comment syntax cannot be confused with an escaped text example.
 */
export function hasSummaryProgress(raw: string): boolean {
  return summaryFieldsHaveText(raw, ['investigated', 'learned', 'completed', 'notes']);
}
