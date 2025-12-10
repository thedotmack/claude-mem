#!/usr/bin/env node
/**
 * Export memories matching a search query to a portable JSON format
 * Usage: npx tsx scripts/export-memories.ts <query> <output-file>
 * Example: npx tsx scripts/export-memories.ts "windows" windows-memories.json
 */

import Database from 'better-sqlite3';
import { existsSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

interface ExportData {
  exportedAt: string;
  exportedAtEpoch: number;
  query: string;
  totalObservations: number;
  totalSessions: number;
  totalSummaries: number;
  totalPrompts: number;
  observations: any[];
  sessions: any[];
  summaries: any[];
  prompts: any[];
}

function exportMemories(query: string, outputFile: string) {
  const dbPath = join(homedir(), '.claude-mem', 'claude-mem.db');

  if (!existsSync(dbPath)) {
    console.error(`❌ Database not found at: ${dbPath}`);
    process.exit(1);
  }

  const db = new Database(dbPath, { readonly: true });

  try {
    console.log(`🔍 Searching for: "${query}"`);

    // Build FTS5 query (escape special characters)
    const ftsQuery = query.replace(/[^a-zA-Z0-9\s]/g, ' ').trim() + '*';

    // Get all observations matching the query
    const observations = db.prepare(`
      SELECT o.*
      FROM observations o
      INNER JOIN observations_fts fts ON o.id = fts.rowid
      WHERE observations_fts MATCH ?
      ORDER BY o.created_at_epoch DESC
    `).all(ftsQuery);

    console.log(`✅ Found ${observations.length} observations`);

    // Get unique SDK session IDs from observations
    const sdkSessionIds = [...new Set(observations.map((o: any) => o.sdk_session_id))];

    // Get all sessions for these SDK sessions
    const sessions = sdkSessionIds.length > 0
      ? db.prepare(`
          SELECT * FROM sdk_sessions
          WHERE sdk_session_id IN (${sdkSessionIds.map(() => '?').join(',')})
          ORDER BY started_at_epoch DESC
        `).all(...sdkSessionIds)
      : [];

    console.log(`✅ Found ${sessions.length} sessions`);

    // Get all summaries for these SDK sessions
    const summaries = sdkSessionIds.length > 0
      ? db.prepare(`
          SELECT * FROM session_summaries
          WHERE sdk_session_id IN (${sdkSessionIds.map(() => '?').join(',')})
          ORDER BY created_at_epoch DESC
        `).all(...sdkSessionIds)
      : [];

    console.log(`✅ Found ${summaries.length} summaries`);

    // Get unique Claude session IDs
    const claudeSessionIds = [...new Set(sessions.map((s: any) => s.claude_session_id))];

    // Get all prompts for these Claude sessions
    const prompts = claudeSessionIds.length > 0
      ? db.prepare(`
          SELECT * FROM user_prompts
          WHERE claude_session_id IN (${claudeSessionIds.map(() => '?').join(',')})
          ORDER BY created_at_epoch DESC
        `).all(...claudeSessionIds)
      : [];

    console.log(`✅ Found ${prompts.length} prompts`);

    // Create export data
    const exportData: ExportData = {
      exportedAt: new Date().toISOString(),
      exportedAtEpoch: Date.now(),
      query,
      totalObservations: observations.length,
      totalSessions: sessions.length,
      totalSummaries: summaries.length,
      totalPrompts: prompts.length,
      observations,
      sessions,
      summaries,
      prompts
    };

    // Write to file
    writeFileSync(outputFile, JSON.stringify(exportData, null, 2));

    console.log(`\n📦 Export complete!`);
    console.log(`📄 Output: ${outputFile}`);
    console.log(`📊 Stats:`);
    console.log(`   • ${exportData.totalObservations} observations`);
    console.log(`   • ${exportData.totalSessions} sessions`);
    console.log(`   • ${exportData.totalSummaries} summaries`);
    console.log(`   • ${exportData.totalPrompts} prompts`);

  } finally {
    db.close();
  }
}

// CLI interface
const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: npx tsx scripts/export-memories.ts <query> <output-file>');
  console.error('Example: npx tsx scripts/export-memories.ts "windows" windows-memories.json');
  process.exit(1);
}

const [query, outputFile] = args;
exportMemories(query, outputFile);
