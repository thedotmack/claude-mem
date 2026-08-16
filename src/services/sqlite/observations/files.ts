
import { logger } from '../../../utils/logger.js';

export function parseFileList(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [String(parsed)];
  } catch (error) {
    logger.debug('DB', 'File list is not JSON; treating value as a single path', { value }, error instanceof Error ? error : new Error(String(error)));
    return [value];
  }
}
