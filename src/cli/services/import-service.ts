/**
 * Import Service - Import data from files
 */

import { existsSync, readFileSync } from 'fs';
import { paths } from '../utils/paths';

export interface ImportResult {
  success: boolean;
  imported: number;
  errors: string[];
}

export class ImportService {
  /**
   * Import observations from JSON
   */
  importJSON(filePath: string): ImportResult {
    const result: ImportResult = { success: false, imported: 0, errors: [] };

    try {
      if (!existsSync(filePath)) {
        result.errors.push(`File not found: ${filePath}`);
        return result;
      }

      const content = readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content);

      if (!Array.isArray(data)) {
        result.errors.push('Invalid format: expected array of observations');
        return result;
      }

      // Note: Actual import would require inserting into database
      // For now, just validate the format
      for (const item of data) {
        if (!item.id || !item.project || !item.type) {
          result.errors.push(`Invalid observation: missing required fields`);
        }
      }

      result.imported = data.length;
      result.success = result.errors.length === 0;
      return result;

    } catch (error) {
      result.errors.push((error as Error).message);
      return result;
    }
  }

  /**
   * Validate import file without importing
   */
  validate(filePath: string): { valid: boolean; count: number; errors: string[] } {
    const result = { valid: false, count: 0, errors: [] as string[] };

    try {
      if (!existsSync(filePath)) {
        result.errors.push(`File not found: ${filePath}`);
        return result;
      }

      const content = readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content);

      if (!Array.isArray(data)) {
        result.errors.push('Invalid format: expected array');
        return result;
      }

      result.count = data.length;
      result.valid = true;
      return result;

    } catch (error) {
      result.errors.push((error as Error).message);
      return result;
    }
  }
}

export const importService = new ImportService();
