import { logger } from '../../utils/logger.js';

/**
 * Parse a stored observation `facts` or `concepts` column into the list
 * Chroma indexes. Columns outside the JSON-array contract (#3423: CJK text
 * stored as a plain string) become one entry instead of being dropped.
 * Backfill and the replica forward both parse through here, so a revised row
 * gets the same fragments backfill indexed.
 *
 * The viewer keeps its own copy in `src/ui/viewer/utils/stored-string-list.ts`
 * (its tsconfig pins rootDir to the viewer directory). Change both together.
 */
export function parseStringListField(
  rawValue: string | null | undefined,
  fieldName: 'facts' | 'concepts',
  rowId: number,
): string[] {
  if (!rawValue) {
    return [];
  }

  try {
    const parsed = JSON.parse(rawValue);
    if (!Array.isArray(parsed)) {
      logger.warn('CHROMA_SYNC', 'Expected JSON array in observation list field, using plain string fallback', {
        fieldName,
        rowId,
        parsedType: typeof parsed,
      });
      if (typeof parsed === 'string') {
        return parsed.trim() ? [parsed] : [];
      }
      return rawValue.trim() ? [rawValue] : [];
    }
    return parsed.filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  } catch (error) {
    logger.warn('CHROMA_SYNC', 'Malformed observation list field, using plain string fallback', {
      fieldName,
      rowId,
      errorName: error instanceof Error ? error.name : 'NonError',
    });
    return rawValue.trim() ? [rawValue] : [];
  }
}
