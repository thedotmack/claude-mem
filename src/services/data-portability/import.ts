/**
 * Import claude-mem data from a portable JSON export file
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { ClaudeMemDatabase } from '../sqlite/Database.js';
import {
  importSdkSession,
  importObservation,
  importSessionSummary,
  importUserPrompt,
} from '../sqlite/Import.js';
import {
  EXPORT_FORMAT_VERSION,
  type ExportData,
  type ImportSummary,
  type TableImportResult,
} from './types.js';

/**
 * Validate that the parsed JSON matches the expected export format
 */
function validateExportData(data: unknown): data is ExportData {
  if (typeof data !== 'object' || data === null) return false;
  const d = data as Record<string, unknown>;
  if (
    typeof d.format_version !== 'number' ||
    d.format_version > EXPORT_FORMAT_VERSION ||
    typeof d.data !== 'object' ||
    d.data === null
  ) {
    return false;
  }
  const tables = d.data as Record<string, unknown>;
  return (
    Array.isArray(tables.sdk_sessions) &&
    Array.isArray(tables.observations) &&
    Array.isArray(tables.session_summaries) &&
    Array.isArray(tables.user_prompts)
  );
}

/**
 * Import claude-mem data from a JSON export file.
 *
 * Uses the existing bulk import functions which perform duplicate checking,
 * making this operation idempotent and safe to run multiple times.
 * Rebuilds the FTS5 full-text search index after import.
 */
export function runImport(filePath: string): ImportSummary {
  const absPath = resolve(filePath);
  const raw = readFileSync(absPath, 'utf-8');
  const parsed: unknown = JSON.parse(raw);

  if (!validateExportData(parsed)) {
    throw new Error(
      `Invalid export file: missing or unsupported format_version (expected <= ${EXPORT_FORMAT_VERSION})`
    );
  }

  const exportData = parsed;
  console.log(`\nImporting from: ${absPath}`);
  console.log(`  Format version: ${exportData.format_version}`);
  console.log(`  Exported at: ${exportData.exported_at}`);
  console.log(`  Source: ${exportData.source_machine}`);
  console.log(`  Claude-mem version: ${exportData.claude_mem_version}`);

  const cmdb = new ClaudeMemDatabase();
  const db = cmdb.db;

  try {
    // Disable FK checks during bulk import — the exported data was consistent
    // in the source DB but FK relationships may not hold if sessions were
    // pruned or observations came from legacy paths.
    db.run('PRAGMA foreign_keys = OFF');

    // Wrap all inserts in a transaction for atomicity and performance
    const doImport = db.transaction(() => {
      const sessionResult = importTable('sdk_sessions', exportData.data.sdk_sessions, (row) =>
        importSdkSession(db, row)
      );

      const obsResult = importTable('observations', exportData.data.observations, (row) =>
        importObservation(db, row)
      );

      const summaryResult = importTable('session_summaries', exportData.data.session_summaries, (row) =>
        importSessionSummary(db, row)
      );

      const promptResult = importTable('user_prompts', exportData.data.user_prompts, (row) =>
        importUserPrompt(db, row)
      );

      return { sessionResult, obsResult, summaryResult, promptResult };
    });

    const { sessionResult, obsResult, summaryResult, promptResult } = doImport();

    // Rebuild FTS5 index if any observations were imported
    if (obsResult.imported > 0 || summaryResult.imported > 0) {
      rebuildFtsIndex(db);
    }

    const summary: ImportSummary = {
      sdk_sessions: sessionResult,
      observations: obsResult,
      session_summaries: summaryResult,
      user_prompts: promptResult,
      total_imported:
        sessionResult.imported + obsResult.imported + summaryResult.imported + promptResult.imported,
      total_skipped:
        sessionResult.skipped + obsResult.skipped + summaryResult.skipped + promptResult.skipped,
    };

    console.log(`\nImport complete:`);
    printTableResult('Sessions', sessionResult);
    printTableResult('Observations', obsResult);
    printTableResult('Summaries', summaryResult);
    printTableResult('Prompts', promptResult);
    console.log(`\n  Total imported: ${summary.total_imported}`);
    console.log(`  Total skipped (duplicates): ${summary.total_skipped}`);

    return summary;
  } finally {
    db.run('PRAGMA foreign_keys = ON');
    cmdb.close();
  }
}

/**
 * Import rows for a single table, tracking results
 */
function importTable<T>(
  tableName: string,
  rows: T[],
  importFn: (row: T) => { imported: boolean }
): TableImportResult {
  const result: TableImportResult = { imported: 0, skipped: 0, errors: 0 };

  for (const row of rows) {
    try {
      const { imported } = importFn(row);
      if (imported) {
        result.imported++;
      } else {
        result.skipped++;
      }
    } catch (err) {
      result.errors++;
      if (result.errors <= 3) {
        console.error(`  Warning: failed to import ${tableName} row: ${(err as Error).message}`);
      }
    }
  }

  return result;
}

/**
 * Rebuild FTS5 full-text search indexes after bulk import
 */
function rebuildFtsIndex(db: InstanceType<typeof ClaudeMemDatabase>['db']): void {
  try {
    db.run(`INSERT INTO observations_fts(observations_fts) VALUES('rebuild')`);
    db.run(`INSERT INTO session_summaries_fts(session_summaries_fts) VALUES('rebuild')`);
    console.log('  Rebuilt FTS5 search indexes');
  } catch {
    // FTS5 may not be available on all platforms
    console.log('  Note: FTS5 index rebuild skipped (not available on this platform)');
  }
}

/** Print a single table's import result */
function printTableResult(label: string, result: TableImportResult): void {
  const parts = [`${result.imported} imported`];
  if (result.skipped > 0) parts.push(`${result.skipped} skipped`);
  if (result.errors > 0) parts.push(`${result.errors} errors`);
  console.log(`  ${label}: ${parts.join(', ')}`);
}

/** CLI entry point — parse args and run import */
export function runImportCli(args: string[]): void {
  const filePath = args[0];
  if (!filePath) {
    console.error('Usage: claude-mem import <file.json>');
    process.exit(1);
  }
  runImport(filePath);
}
