/**
 * Parse a stored observation list column (facts, concepts, files_read,
 * files_modified) for display on a card.
 *
 * Mirrors `parseStringListField` in `src/services/sync/string-list-field.ts`:
 * the viewer's tsconfig pins rootDir to this directory (see
 * `constants/promo.ts`), so it cannot import the Node-side module. Change both
 * together.
 *
 * Same contract as the sync copy:
 * - a JSON array keeps its string entries that are not blank;
 * - a JSON string scalar is one entry, unless blank;
 * - text that is not JSON is one entry, unless blank (#3423: CJK facts stored
 *   as a plain string);
 * - null and the empty string give nothing.
 *
 * One deliberate difference: JSON null, numbers, booleans and objects give
 * nothing here, where the sync copy keeps the raw text. The observation writer
 * stores `JSON.stringify(observation.facts)`, so `'null'` is a real stored
 * value, and a card showing "null" or raw JSON as a fact is noise.
 */
export function parseStoredStringList(rawValue: string | null | undefined): string[] {
  if (!rawValue) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    // Not JSON: plain text (#3423) is one entry.
    return rawValue.trim() ? [rawValue] : [];
  }
  if (Array.isArray(parsed)) {
    return parsed.filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  }
  if (typeof parsed === 'string') return parsed.trim() ? [parsed] : [];
  return [];
}
