/** Prompts shorter than this get no injection: too little to search on. */
export const SEMANTIC_CONTEXT_MIN_QUERY_CHARS = 20;
/** Most observations one prompt's injection returns. */
export const SEMANTIC_CONTEXT_MAX_LIMIT = 20;

/** One observation as per-prompt semantic injection shows it. */
export interface SemanticContextItem {
  title?: string | null;
  narrative?: string | null;
  /** YYYY-MM-DD, or '' when unknown. */
  date: string;
}

/**
 * The injected context for observations near a prompt: a header, then each
 * observation's title, date and narrative. The worker's /api/context/semantic
 * and the server's /v1/context/semantic both render through this, so the
 * session-init hook sees the same text from either runtime. '' for no items.
 */
export function renderSemanticContext(items: SemanticContextItem[]): string {
  if (items.length === 0) return '';
  const lines: string[] = ['## Relevant Past Work (semantic match)\n'];
  for (const item of items) {
    lines.push(`### ${item.title || 'Observation'} (${item.date})`);
    if (item.narrative) lines.push(item.narrative);
    lines.push('');
  }
  return lines.join('\n');
}
