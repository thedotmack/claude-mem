#!/usr/bin/env node
/**
 * Restore Endless Mode Transcript
 *
 * Restores a compressed transcript to its original state by replacing
 * compressed observations with original tool outputs from the backup file.
 *
 * Usage:
 *   npm run endless-mode:restore <transcript-path>
 *   npm run endless-mode:restore /path/to/session.jsonl
 *
 * This allows users to disable Endless Mode and return to uncompressed transcripts.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { lookupToolOutput, getBackupInfo } from '../shared/tool-output-backup.js';
import type { TranscriptEntry, UserTranscriptEntry, ToolResultContent } from '../types/transcript.js';

interface RestoreStats {
  totalToolResults: number;
  restoredFromBackup: number;
  missingFromBackup: number;
  originalSize: number;
  restoredSize: number;
}

/**
 * Strip suffix from tool_use_id (handles __1, __2, __3 format for multi-observation responses)
 * Example: toolu_01ABC__2 -> toolu_01ABC
 */
function stripToolUseIdSuffix(toolUseId: string): string {
  return toolUseId.replace(/__\d+$/, '');
}

function restoreTranscript(transcriptPath: string, outputPath?: string): RestoreStats {
  // Validate input
  if (!existsSync(transcriptPath)) {
    throw new Error(`Transcript file not found: ${transcriptPath}`);
  }

  console.log(`Reading transcript: ${transcriptPath}`);

  // Read transcript
  const transcriptContent = readFileSync(transcriptPath, 'utf-8');
  const lines = transcriptContent.trim().split('\n');

  const stats: RestoreStats = {
    totalToolResults: 0,
    restoredFromBackup: 0,
    missingFromBackup: 0,
    originalSize: 0,
    restoredSize: 0
  };

  // Process each line
  const restoredLines = lines.map((line, i) => {
    if (!line.trim()) return line;

    try {
      const entry: TranscriptEntry = JSON.parse(line);

      // Look for user messages with tool_result content
      if (entry.type === 'user') {
        const userEntry = entry as UserTranscriptEntry;
        const content = userEntry.message.content;

        // Check if content is an array
        if (Array.isArray(content)) {
          // Find and restore tool_results
          for (let j = 0; j < content.length; j++) {
            const item = content[j];
            if (item.type === 'tool_result') {
              const toolResult = item as ToolResultContent;
              stats.totalToolResults++;

              // Measure current size
              const currentSize = JSON.stringify(toolResult.content).length;
              stats.originalSize += currentSize;

              // Strip suffix from tool_use_id before lookup (handles __1, __2, __3 format)
              const baseToolUseId = stripToolUseIdSuffix(toolResult.tool_use_id);

              // Look up original output in backup using base ID
              const originalOutput = lookupToolOutput(baseToolUseId);

              if (originalOutput !== null) {
                // Restore original content
                toolResult.content = originalOutput;
                stats.restoredFromBackup++;

                // Measure restored size
                const restoredSize = JSON.stringify(originalOutput).length;
                stats.restoredSize += restoredSize;

                console.log(`  ✓ Restored tool_use_id: ${toolResult.tool_use_id} (${currentSize} → ${restoredSize} chars)`);
              } else {
                // Original not found in backup
                stats.missingFromBackup++;
                stats.restoredSize += currentSize;

                console.log(`  ✗ Original not found for tool_use_id: ${toolResult.tool_use_id} (base: ${baseToolUseId})`);
              }
            }
          }
        }
      }

      return JSON.stringify(entry);
    } catch (parseError: any) {
      console.warn(`Warning: Malformed JSONL line at index ${i}, skipping`);
      return line;
    }
  });

  // Write restored transcript
  const output = outputPath || `${transcriptPath}.restored`;
  writeFileSync(output, restoredLines.join('\n') + '\n', 'utf-8');

  console.log(`\nRestored transcript written to: ${output}`);

  return stats;
}

function printBackupInfo() {
  const info = getBackupInfo();

  console.log('\n=== Tool Output Backup Info ===');
  if (!info.exists) {
    console.log('Backup file does not exist yet.');
    console.log('Enable Endless Mode and run some commands to create backup.');
    return;
  }

  console.log(`Size: ${info.sizeMB} MB`);
  console.log(`Entries: ${info.entryCount}`);

  if (info.oldestTimestamp && info.newestTimestamp) {
    const oldestDate = new Date(info.oldestTimestamp).toISOString();
    const newestDate = new Date(info.newestTimestamp).toISOString();
    console.log(`Oldest entry: ${oldestDate}`);
    console.log(`Newest entry: ${newestDate}`);

    const ageMs = info.newestTimestamp - info.oldestTimestamp;
    const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
    const ageHours = Math.floor((ageMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    console.log(`Time span: ${ageDays}d ${ageHours}h`);
  }

  console.log('');
}

function main() {
  const args = process.argv.slice(2);

  // Handle --info flag
  if (args.includes('--info')) {
    printBackupInfo();
    process.exit(0);
  }

  if (args.length === 0) {
    console.error('Usage: npm run endless-mode:restore <transcript-path>');
    console.error('   or: npm run endless-mode:restore -- --info');
    console.error('');
    console.error('Examples:');
    console.error('  npm run endless-mode:restore ~/.claude/projects/my-project/abc123.jsonl');
    console.error('  npm run endless-mode:restore -- --info');
    process.exit(1);
  }

  const transcriptPath = args[0];
  const outputPath = args[1]; // Optional

  try {
    console.log('=== Endless Mode Transcript Restore ===\n');

    printBackupInfo();

    const stats = restoreTranscript(transcriptPath, outputPath);

    console.log('\n=== Restore Stats ===');
    console.log(`Total tool results: ${stats.totalToolResults}`);
    console.log(`Restored from backup: ${stats.restoredFromBackup}`);
    console.log(`Missing from backup: ${stats.missingFromBackup}`);
    console.log(`Original size: ${stats.originalSize.toLocaleString()} chars`);
    console.log(`Restored size: ${stats.restoredSize.toLocaleString()} chars`);

    if (stats.originalSize > 0) {
      const changePercent = Math.round(((stats.restoredSize - stats.originalSize) / stats.originalSize) * 100);
      console.log(`Size change: ${changePercent > 0 ? '+' : ''}${changePercent}%`);
    }

    if (stats.missingFromBackup > 0) {
      console.log('\n⚠️  Some tool outputs could not be restored (missing from backup).');
      console.log('This may happen if the backup was trimmed or the session predates the backup system.');
    }

    console.log('\n✓ Restore complete!');
  } catch (error: any) {
    console.error(`\n✗ Restore failed: ${error.message}`);
    process.exit(1);
  }
}

main();
