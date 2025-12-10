#!/usr/bin/env node
/**
 * Import memories from a JSON export file with duplicate prevention
 * Usage: npx tsx scripts/import-memories.ts <input-file>
 * Example: npx tsx scripts/import-memories.ts windows-memories.json
 */

import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

interface ImportStats {
  sessionsImported: number;
  sessionsSkipped: number;
  summariesImported: number;
  summariesSkipped: number;
  observationsImported: number;
  observationsSkipped: number;
  promptsImported: number;
  promptsSkipped: number;
}

function importMemories(inputFile: string) {
  if (!existsSync(inputFile)) {
    console.error(`❌ Input file not found: ${inputFile}`);
    process.exit(1);
  }

  const dbPath = join(homedir(), '.claude-mem', 'claude-mem.db');

  if (!existsSync(dbPath)) {
    console.error(`❌ Database not found at: ${dbPath}`);
    process.exit(1);
  }

  // Read and parse export file
  const exportData = JSON.parse(readFileSync(inputFile, 'utf-8'));

  console.log(`📦 Import file: ${inputFile}`);
  console.log(`📅 Exported: ${exportData.exportedAt}`);
  console.log(`🔍 Query: "${exportData.query}"`);
  console.log(`📊 Contains:`);
  console.log(`   • ${exportData.totalObservations} observations`);
  console.log(`   • ${exportData.totalSessions} sessions`);
  console.log(`   • ${exportData.totalSummaries} summaries`);
  console.log(`   • ${exportData.totalPrompts} prompts`);
  console.log('');

  const db = new Database(dbPath);
  const stats: ImportStats = {
    sessionsImported: 0,
    sessionsSkipped: 0,
    summariesImported: 0,
    summariesSkipped: 0,
    observationsImported: 0,
    observationsSkipped: 0,
    promptsImported: 0,
    promptsSkipped: 0
  };

  try {
    // Prepare statements for duplicate checking
    const checkSession = db.prepare('SELECT id FROM sdk_sessions WHERE claude_session_id = ?');
    const checkSummary = db.prepare('SELECT id FROM session_summaries WHERE sdk_session_id = ?');
    const checkObservation = db.prepare(`
      SELECT id FROM observations
      WHERE sdk_session_id = ?
        AND title = ?
        AND created_at_epoch = ?
    `);
    const checkPrompt = db.prepare(`
      SELECT id FROM user_prompts
      WHERE claude_session_id = ?
        AND prompt_number = ?
    `);

    // Prepare insert statements
    const insertSession = db.prepare(`
      INSERT INTO sdk_sessions (
        claude_session_id, sdk_session_id, project, user_prompt,
        started_at, started_at_epoch, completed_at, completed_at_epoch,
        status, worker_port, prompt_counter
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertSummary = db.prepare(`
      INSERT INTO session_summaries (
        sdk_session_id, project, request, investigated, learned,
        completed, next_steps, files_read, files_edited, notes,
        prompt_number, discovery_tokens, created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertObservation = db.prepare(`
      INSERT INTO observations (
        sdk_session_id, project, text, type, title, subtitle,
        facts, narrative, concepts, files_read, files_modified,
        prompt_number, discovery_tokens, created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertPrompt = db.prepare(`
      INSERT INTO user_prompts (
        claude_session_id, prompt_number, prompt_text,
        created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?)
    `);

    // Import in transaction
    db.transaction(() => {
      // 1. Import sessions first (dependency for everything else)
      console.log('🔄 Importing sessions...');
      for (const session of exportData.sessions) {
        const exists = checkSession.get(session.claude_session_id);
        if (exists) {
          stats.sessionsSkipped++;
          continue;
        }

        insertSession.run(
          session.claude_session_id,
          session.sdk_session_id,
          session.project,
          session.user_prompt,
          session.started_at,
          session.started_at_epoch,
          session.completed_at,
          session.completed_at_epoch,
          session.status,
          session.worker_port || null,
          session.prompt_counter || null
        );
        stats.sessionsImported++;
      }
      console.log(`   ✅ Imported: ${stats.sessionsImported}, Skipped: ${stats.sessionsSkipped}`);

      // 2. Import summaries (depends on sessions)
      console.log('🔄 Importing summaries...');
      for (const summary of exportData.summaries) {
        const exists = checkSummary.get(summary.sdk_session_id);
        if (exists) {
          stats.summariesSkipped++;
          continue;
        }

        insertSummary.run(
          summary.sdk_session_id,
          summary.project,
          summary.request,
          summary.investigated,
          summary.learned,
          summary.completed,
          summary.next_steps,
          summary.files_read,
          summary.files_edited,
          summary.notes,
          summary.prompt_number,
          summary.discovery_tokens || 0,
          summary.created_at,
          summary.created_at_epoch
        );
        stats.summariesImported++;
      }
      console.log(`   ✅ Imported: ${stats.summariesImported}, Skipped: ${stats.summariesSkipped}`);

      // 3. Import observations (depends on sessions)
      console.log('🔄 Importing observations...');
      for (const obs of exportData.observations) {
        const exists = checkObservation.get(
          obs.sdk_session_id,
          obs.title,
          obs.created_at_epoch
        );
        if (exists) {
          stats.observationsSkipped++;
          continue;
        }

        insertObservation.run(
          obs.sdk_session_id,
          obs.project,
          obs.text,
          obs.type,
          obs.title,
          obs.subtitle,
          obs.facts,
          obs.narrative,
          obs.concepts,
          obs.files_read,
          obs.files_modified,
          obs.prompt_number,
          obs.discovery_tokens || 0,
          obs.created_at,
          obs.created_at_epoch
        );
        stats.observationsImported++;
      }
      console.log(`   ✅ Imported: ${stats.observationsImported}, Skipped: ${stats.observationsSkipped}`);

      // 4. Import prompts (depends on sessions)
      console.log('🔄 Importing prompts...');
      for (const prompt of exportData.prompts) {
        const exists = checkPrompt.get(
          prompt.claude_session_id,
          prompt.prompt_number
        );
        if (exists) {
          stats.promptsSkipped++;
          continue;
        }

        insertPrompt.run(
          prompt.claude_session_id,
          prompt.prompt_number,
          prompt.prompt_text,
          prompt.created_at,
          prompt.created_at_epoch
        );
        stats.promptsImported++;
      }
      console.log(`   ✅ Imported: ${stats.promptsImported}, Skipped: ${stats.promptsSkipped}`);

    })();

    console.log('\n✅ Import complete!');
    console.log('📊 Summary:');
    console.log(`   Sessions:     ${stats.sessionsImported} imported, ${stats.sessionsSkipped} skipped`);
    console.log(`   Summaries:    ${stats.summariesImported} imported, ${stats.summariesSkipped} skipped`);
    console.log(`   Observations: ${stats.observationsImported} imported, ${stats.observationsSkipped} skipped`);
    console.log(`   Prompts:      ${stats.promptsImported} imported, ${stats.promptsSkipped} skipped`);

  } finally {
    db.close();
  }
}

// CLI interface
const args = process.argv.slice(2);
if (args.length < 1) {
  console.error('Usage: npx tsx scripts/import-memories.ts <input-file>');
  console.error('Example: npx tsx scripts/import-memories.ts windows-memories.json');
  process.exit(1);
}

const [inputFile] = args;
importMemories(inputFile);
