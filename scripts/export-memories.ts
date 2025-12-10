#!/usr/bin/env node
/**
 * Export memories matching a search query to a portable JSON format
 * Usage: npx tsx scripts/export-memories.ts <query> <output-file> [--project=name]
 * Example: npx tsx scripts/export-memories.ts "windows" windows-memories.json --project=claude-mem
 */

import Database from 'better-sqlite3';
import { existsSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

interface ExportData {
  exportedAt: string;
  exportedAtEpoch: number;
  query: string;
  project?: string;
  totalObservations: number;
  totalSessions: number;
  totalSummaries: number;
  totalPrompts: number;
  observations: any[];
  sessions: any[];
  summaries: any[];
  prompts: any[];
}

async function exportMemories(query: string, outputFile: string, project?: string, port: number = 37777) {
  try {
    const baseUrl = `http://localhost:${port}`;

    console.log(`🔍 Searching for: "${query}"${project ? ` (project: ${project})` : ' (all projects)'}`);

    // Build query params - use format=json for raw data
    const params = new URLSearchParams({
      query,
      format: 'json',
      limit: '999999'
    });
    if (project) params.set('project', project);

    // Unified search - gets all result types using hybrid search
    console.log('📡 Fetching all memories via hybrid search...');
    const searchResponse = await fetch(`${baseUrl}/api/search?${params.toString()}`);
    if (!searchResponse.ok) {
      throw new Error(`Failed to search: ${searchResponse.status} ${searchResponse.statusText}`);
    }
    const searchData = await searchResponse.json();

    const observations = searchData.observations || [];
    const summaries = searchData.sessions || [];
    const prompts = searchData.prompts || [];

    console.log(`✅ Found ${observations.length} observations`);
    console.log(`✅ Found ${summaries.length} session summaries`);
    console.log(`✅ Found ${prompts.length} user prompts`);

    // Get unique SDK session IDs from observations and summaries
    const sdkSessionIds = new Set<string>();
    observations.forEach((o: any) => {
      if (o.sdk_session_id) sdkSessionIds.add(o.sdk_session_id);
    });
    summaries.forEach((s: any) => {
      if (s.sdk_session_id) sdkSessionIds.add(s.sdk_session_id);
    });

    // Get SDK sessions metadata from database
    // (We need this because the API doesn't expose sdk_sessions table directly)
    console.log('📡 Fetching SDK sessions metadata...');
    const sessions: any[] = [];
    if (sdkSessionIds.size > 0) {
      // Read directly from database for sdk_sessions table
      const Database = (await import('better-sqlite3')).default;
      const dbPath = join(homedir(), '.claude-mem', 'claude-mem.db');
      const db = new Database(dbPath, { readonly: true });

      try {
        const placeholders = Array.from(sdkSessionIds).map(() => '?').join(',');
        const query = `
          SELECT * FROM sdk_sessions
          WHERE sdk_session_id IN (${placeholders})
          ORDER BY started_at_epoch DESC
        `;
        sessions.push(...db.prepare(query).all(...Array.from(sdkSessionIds)));
      } finally {
        db.close();
      }
    }
    console.log(`✅ Found ${sessions.length} SDK sessions`);

    // Create export data
    const exportData: ExportData = {
      exportedAt: new Date().toISOString(),
      exportedAtEpoch: Date.now(),
      query,
      project,
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

  } catch (error) {
    console.error('❌ Export failed:', error);
    process.exit(1);
  }
}

// CLI interface
const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: npx tsx scripts/export-memories.ts <query> <output-file> [--project=name]');
  console.error('Example: npx tsx scripts/export-memories.ts "windows" windows-memories.json --project=claude-mem');
  console.error('         npx tsx scripts/export-memories.ts "authentication" auth.json');
  process.exit(1);
}

// Parse arguments
const [query, outputFile, ...flags] = args;
const project = flags.find(f => f.startsWith('--project='))?.split('=')[1];

exportMemories(query, outputFile, project);
