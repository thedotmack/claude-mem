/**
 * Test Script: Transform Real Transcript
 *
 * Tests the TranscriptTransformer class on a real transcript file
 * by fetching observations from the database and transforming tool uses
 */

import { readFileSync, copyFileSync, existsSync } from 'fs';
import { TranscriptTransformer, TranscriptBackupManager } from '../src/services/transcript-transformer.js';
import { SessionStore } from '../src/services/sqlite/SessionStore.js';
import { BACKUPS_DIR } from '../src/shared/paths.js';
import type { TranscriptEntry, UserTranscriptEntry, ToolResultContent } from '../src/types/transcript.js';

interface ToolUseInfo {
  toolUseId: string;
  lineNumber: number;
  toolName?: string;
  originalSize: number;
}

/**
 * Extract all tool uses from transcript
 */
function extractToolUses(transcriptPath: string): ToolUseInfo[] {
  const content = readFileSync(transcriptPath, 'utf-8');
  const lines = content.trim().split('\n');
  const toolUses: ToolUseInfo[] = [];

  lines.forEach((line, index) => {
    if (!line.trim()) return;

    try {
      const entry: TranscriptEntry = JSON.parse(line);

      // Look for assistant messages with tool_use (these have the large inputs)
      if (entry.type === 'assistant') {
        const assistantEntry = entry as any;
        const content = assistantEntry.message?.content;

        if (Array.isArray(content)) {
          for (const item of content) {
            if (item.type === 'tool_use') {
              const toolUse = item as any;
              const inputStr = JSON.stringify(toolUse.input);

              toolUses.push({
                toolUseId: toolUse.id,
                lineNumber: index + 1,
                toolName: toolUse.name,
                originalSize: inputStr.length
              });
            }
          }
        }
      }
    } catch (error) {
      console.error(`Error parsing line ${index + 1}:`, error);
    }
  });

  return toolUses;
}

/**
 * Main test function
 */
async function testTransformation() {
  // Configuration
  const TRANSCRIPT_PATH = process.argv[2] || '/Users/alexnewman/.claude/projects/-Users-alexnewman-Scripts-claude-mem/96890334-a801-4bce-bdc7-b3aa19678a21.jsonl';
  const DRY_RUN = process.argv.includes('--dry-run');

  console.log('='.repeat(80));
  console.log('TRANSCRIPT TRANSFORMATION TEST');
  console.log('='.repeat(80));
  console.log(`Transcript: ${TRANSCRIPT_PATH}`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no changes)' : 'LIVE (will modify file)'}`);
  console.log('='.repeat(80));
  console.log();

  // Verify transcript exists
  if (!existsSync(TRANSCRIPT_PATH)) {
    console.error(`❌ Transcript file not found: ${TRANSCRIPT_PATH}`);
    process.exit(1);
  }

  // Create working copy for testing
  const WORKING_COPY = DRY_RUN ? `${TRANSCRIPT_PATH}.test-copy` : TRANSCRIPT_PATH;
  if (DRY_RUN) {
    console.log(`📋 Creating working copy for dry run...`);
    copyFileSync(TRANSCRIPT_PATH, WORKING_COPY);
    console.log(`   ✓ Copied to: ${WORKING_COPY}`);
    console.log();
  }

  // Extract tool uses
  console.log('📊 Extracting tool uses from transcript...');
  const toolUses = extractToolUses(WORKING_COPY);
  console.log(`   ✓ Found ${toolUses.length} tool uses`);
  console.log();

  // Connect to database
  console.log('🗄️  Connecting to database...');
  const db = new SessionStore();

  // Fetch observations for each tool use
  console.log('🔍 Fetching observations from database...');
  const transformations: Array<{ toolUseId: string; observation: any; toolUse: ToolUseInfo }> = [];

  for (const toolUse of toolUses) {
    try {
      const result = db.db.prepare(`
        SELECT *
        FROM observations
        WHERE tool_use_id = ?
        LIMIT 1
      `).get(toolUse.toolUseId);

      if (result) {
        transformations.push({
          toolUseId: toolUse.toolUseId,
          observation: result,
          toolUse
        });
        const sizeKB = (toolUse.originalSize / 1024).toFixed(1);
        console.log(`   ✓ ${toolUse.toolName || 'unknown'} ${toolUse.toolUseId.substring(0, 20)}... (line ${toolUse.lineNumber}, ${sizeKB}KB)`);
      } else {
        console.log(`   ⚠️  ${toolUse.toolName || 'unknown'} ${toolUse.toolUseId.substring(0, 20)}... (no observation found)`);
      }
    } catch (error) {
      console.error(`   ❌ Error fetching observation for ${toolUse.toolUseId}:`, error);
    }
  }

  console.log();
  console.log(`📈 Summary: ${transformations.length}/${toolUses.length} tool uses have observations`);
  console.log();

  // Create backup manager
  const backupManager = new TranscriptBackupManager(BACKUPS_DIR, 50);

  // Create backup before transforming
  if (!DRY_RUN) {
    console.log('💾 Creating backup...');
    try {
      const backupPath = await backupManager.createBackup(WORKING_COPY);
      console.log(`   ✓ Backup created: ${backupPath}`);
    } catch (error) {
      console.error(`   ❌ Backup failed:`, error);
      db.close();
      process.exit(1);
    }
    console.log();
  }

  // Transform each tool use
  console.log('🔄 Transforming tool uses...');
  console.log();

  const transformer = new TranscriptTransformer(WORKING_COPY);
  const TRANSFORMED_OUTPUT = `${TRANSCRIPT_PATH}.transformed`;
  let totalOriginalTokens = 0;
  let totalCompressedTokens = 0;
  let successCount = 0;
  let failureCount = 0;

  for (const { toolUseId, observation, toolUse } of transformations) {
    try {
      console.log(`   Transforming ${toolUseId.substring(0, 20)}... (line ${toolUse.lineNumber})`);
      console.log(`   Title: "${observation.title}"`);

      const stats = await transformer.transform(toolUseId, observation, TRANSFORMED_OUTPUT);

      totalOriginalTokens += stats.originalTokens;
      totalCompressedTokens += stats.compressedTokens;
      successCount++;

      const savingsPercent = Math.round((1 - stats.compressedTokens / stats.originalTokens) * 100);
      console.log(`   ✓ ${stats.originalSize} → ${stats.compressedSize} chars (${savingsPercent}% reduction)`);
      console.log(`   ✓ ${stats.originalTokens} → ${stats.compressedTokens} tokens`);
      console.log();
    } catch (error) {
      failureCount++;
      console.error(`   ❌ Transformation failed:`, error);
      console.log();
    }
  }

  db.close();

  // Final summary
  console.log('='.repeat(80));
  console.log('TRANSFORMATION COMPLETE');
  console.log('='.repeat(80));
  console.log(`✓ Successful transformations: ${successCount}`);
  console.log(`✗ Failed transformations: ${failureCount}`);
  console.log();
  console.log('Token Reduction:');
  console.log(`  Original:    ${totalOriginalTokens.toLocaleString()} tokens`);
  console.log(`  Compressed:  ${totalCompressedTokens.toLocaleString()} tokens`);
  console.log(`  Saved:       ${(totalOriginalTokens - totalCompressedTokens).toLocaleString()} tokens`);
  console.log(`  Reduction:   ${Math.round((1 - totalCompressedTokens / totalOriginalTokens) * 100)}%`);
  console.log();

  console.log(`📄 Transformed file: ${TRANSFORMED_OUTPUT}`);
  console.log(`   To view: cat "${TRANSFORMED_OUTPUT}"`);

  if (DRY_RUN) {
    console.log();
    console.log(`📋 Dry run complete. Working copy: ${WORKING_COPY}`);
    console.log(`   To clean up: rm "${WORKING_COPY}" "${TRANSFORMED_OUTPUT}"`);
  } else {
    console.log(`   Original backup: ${BACKUPS_DIR}`);
  }
  console.log('='.repeat(80));
}

// Run test
testTransformation().catch(error => {
  console.error('❌ Test failed:', error);
  process.exit(1);
});
