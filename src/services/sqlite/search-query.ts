/**
 * Code-point ranges of the scripts FTS5's unicode61 tokenizer cannot segment: Thai and Lao,
 * Myanmar, Khmer, Hiragana/Katakana, Bopomofo and Hangul compatibility jamo, the CJK
 * ideograph blocks, and Hangul syllables. Shared by distilled-memory and raw-tool search.
 */
const UNSEGMENTED_SCRIPT_RANGES =
  '\\u0E00-\\u0EFF\\u1000-\\u109F\\u1780-\\u17FF\\u3040-\\u30FF\\u3100-\\u318F\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uAC00-\\uD7AF\\uF900-\\uFAFF';

export const UNSEGMENTED_SCRIPT = new RegExp(`[${UNSEGMENTED_SCRIPT_RANGES}]`);
const UNSEGMENTED_RUN = new RegExp(`[${UNSEGMENTED_SCRIPT_RANGES}]+|[^\\s${UNSEGMENTED_SCRIPT_RANGES}]+`, 'g');
export const MAX_SUBSTRING_TERMS = 500;
export function substringTerms(query: string): string[] {
  return [...new Set(query.match(UNSEGMENTED_RUN) ?? [])].slice(0, MAX_SUBSTRING_TERMS);
}

export function buildSubstringClause(query: string, columns: string[]): { clause: string; params: string[] } {
  const terms = substringTerms(query);
  if (terms.length === 0) {
    terms.push(query);
  }
  const params: string[] = [];
  const groups = terms.map(term => {
    const pattern = `%${term.replace(/[\\%_]/g, '\\$&')}%`;
    for (let i = 0; i < columns.length; i += 1) {
      params.push(pattern);
    }
    return `(${columns.map(column => `${column} LIKE ? ESCAPE '\\'`).join(' OR ')})`;
  });
  return { clause: `(${groups.join(' AND ')})`, params };
}


export function buildFTSMatchQuery(query: string): string {
  const tokens = (query.match(/\S+/g) ?? []).filter(token => /[\p{L}\p{N}]/u.test(token));
  if (tokens.length === 0) {
    return `"${query.replace(/"/g, '""')}"`;
  }

  return tokens
    .map(token => `"${token.replace(/"/g, '""')}"`)
    .join(' AND ');
}
