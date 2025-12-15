#!/usr/bin/env node
/**
 * Import memories from a JSON export file with duplicate prevention
 * Usage: npx tsx scripts/import-memories.ts <input-file>
 * Example: npx tsx scripts/import-memories.ts windows-memories.json
 *
 * This script uses the worker API instead of direct database access.
 */

import { existsSync, readFileSync } from 'fs';

const WORKER_PORT = process.env.CLAUDE_MEM_WORKER_PORT || 37777;
const WORKER_URL = `http://127.0.0.1:${WORKER_PORT}`;

async function importMemories(inputFile: string) {
  if (!existsSync(inputFile)) {
    console.error(`❌ Input file not found: ${inputFile}`);
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

  // Check if worker is running
  try {
    const healthCheck = await fetch(`${WORKER_URL}/api/stats`);
    if (!healthCheck.ok) {
      throw new Error('Worker not responding');
    }
  } catch (error) {
    console.error(`❌ Worker not running at ${WORKER_URL}`);
    console.error('   Please ensure the claude-mem worker is running.');
    process.exit(1);
  }

  console.log('🔄 Importing via worker API...');

  // Send import request to worker
  const response = await fetch(`${WORKER_URL}/api/import`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      sessions: exportData.sessions || [],
      summaries: exportData.summaries || [],
      observations: exportData.observations || [],
      prompts: exportData.prompts || []
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`❌ Import failed: ${response.status} ${response.statusText}`);
    console.error(`   ${errorText}`);
    process.exit(1);
  }

  const result = await response.json();
  const stats = result.stats;

  console.log('\n✅ Import complete!');
  console.log('📊 Summary:');
  console.log(`   Sessions:     ${stats.sessionsImported} imported, ${stats.sessionsSkipped} skipped`);
  console.log(`   Summaries:    ${stats.summariesImported} imported, ${stats.summariesSkipped} skipped`);
  console.log(`   Observations: ${stats.observationsImported} imported, ${stats.observationsSkipped} skipped`);
  console.log(`   Prompts:      ${stats.promptsImported} imported, ${stats.promptsSkipped} skipped`);
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
