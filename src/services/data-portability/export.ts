/**
 * Export claude-mem data to a portable JSON file
 */

import { writeFileSync } from 'fs';
import { hostname } from 'os';
import { resolve } from 'path';
import { ClaudeMemDatabase } from '../sqlite/Database.js';
import {
  EXPORT_FORMAT_VERSION,
  type ExportData,
  type ExportSdkSession,
  type ExportObservation,
  type ExportSessionSummary,
  type ExportUserPrompt,
} from './types.js';

/**
 * Read the installed claude-mem version from package.json
 */
function getVersion(): string {
  try {
    const pkg = require('../../../package.json');
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Generate default export filename with timestamp
 */
function defaultExportPath(): string {
  const ts = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, 19);
  return resolve(`claude-mem-export-${ts}.json`);
}

/**
 * Export all claude-mem data to a JSON file.
 *
 * Reads sdk_sessions, observations, session_summaries, and user_prompts
 * from the SQLite database and writes them as a structured JSON file
 * that can be imported on another machine.
 */
export function runExport(outputPath?: string): string {
  const filePath = outputPath ? resolve(outputPath) : defaultExportPath();

  const cmdb = new ClaudeMemDatabase();
  const db = cmdb.db;

  try {
    const sessions = db
      .prepare(
        `SELECT content_session_id, memory_session_id, project, user_prompt,
                started_at, started_at_epoch, completed_at, completed_at_epoch, status
         FROM sdk_sessions ORDER BY started_at_epoch ASC`
      )
      .all() as ExportSdkSession[];

    const observations = db
      .prepare(
        `SELECT memory_session_id, project, text, type, title, subtitle,
                facts, narrative, concepts, files_read, files_modified,
                prompt_number, discovery_tokens, created_at, created_at_epoch
         FROM observations ORDER BY created_at_epoch ASC`
      )
      .all() as ExportObservation[];

    const summaries = db
      .prepare(
        `SELECT memory_session_id, project, request, investigated, learned,
                completed, next_steps, files_read, files_edited, notes,
                prompt_number, discovery_tokens, created_at, created_at_epoch
         FROM session_summaries ORDER BY created_at_epoch ASC`
      )
      .all() as ExportSessionSummary[];

    const prompts = db
      .prepare(
        `SELECT content_session_id, prompt_number, prompt_text,
                created_at, created_at_epoch
         FROM user_prompts ORDER BY created_at_epoch ASC`
      )
      .all() as ExportUserPrompt[];

    const exportData: ExportData = {
      format_version: EXPORT_FORMAT_VERSION,
      claude_mem_version: getVersion(),
      exported_at: new Date().toISOString(),
      source_machine: hostname(),
      counts: {
        sdk_sessions: sessions.length,
        observations: observations.length,
        session_summaries: summaries.length,
        user_prompts: prompts.length,
      },
      data: {
        sdk_sessions: sessions,
        observations: observations,
        session_summaries: summaries,
        user_prompts: prompts,
      },
    };

    writeFileSync(filePath, JSON.stringify(exportData, null, 2));

    console.log(`\nExported claude-mem data:`);
    console.log(`  Sessions:  ${sessions.length}`);
    console.log(`  Observations: ${observations.length}`);
    console.log(`  Summaries: ${summaries.length}`);
    console.log(`  Prompts:   ${prompts.length}`);
    console.log(`\nWritten to: ${filePath}`);

    return filePath;
  } finally {
    cmdb.close();
  }
}

/** CLI entry point — parse args and run export */
export function runExportCli(args: string[]): void {
  const outputIdx = args.indexOf('--output');
  if (outputIdx !== -1 && !args[outputIdx + 1]) {
    console.error('Usage: claude-mem export [--output <path>]');
    process.exit(1);
  }
  const outputPath = outputIdx !== -1 ? args[outputIdx + 1] : undefined;
  runExport(outputPath);
}
