#!/usr/bin/env tsx
/**
 * Test script for TranscriptParser
 * Validates data extraction from Claude Code transcript JSONL files
 *
 * Usage: npx tsx scripts/test-transcript-parser.ts <path-to-transcript.jsonl>
 */

import { TranscriptParser } from '../src/utils/transcript-parser.js';
import { existsSync } from 'fs';
import { resolve } from 'path';

function formatTokens(num: number): string {
  return num.toLocaleString();
}

function formatPercentage(num: number): string {
  return `${(num * 100).toFixed(2)}%`;
}

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('Usage: npx tsx scripts/test-transcript-parser.ts <path-to-transcript.jsonl>');
    console.error('\nExample: npx tsx scripts/test-transcript-parser.ts ~/.cache/claude-code/transcripts/latest.jsonl');
    process.exit(1);
  }

  const transcriptPath = resolve(args[0]);

  if (!existsSync(transcriptPath)) {
    console.error(`Error: Transcript file not found: ${transcriptPath}`);
    process.exit(1);
  }

  console.log(`\n🔍 Parsing transcript: ${transcriptPath}\n`);

  try {
    const parser = new TranscriptParser(transcriptPath);

    // Get parse statistics
    const stats = parser.getParseStats();

    console.log('📊 Parse Statistics:');
    console.log('─'.repeat(60));
    console.log(`Total lines:      ${stats.totalLines}`);
    console.log(`Parsed entries:   ${stats.parsedEntries}`);
    console.log(`Failed lines:     ${stats.failedLines}`);
    console.log(`Failure rate:     ${formatPercentage(stats.failureRate)}`);
    console.log();

    console.log('📋 Entries by Type:');
    console.log('─'.repeat(60));
    for (const [type, count] of Object.entries(stats.entriesByType)) {
      console.log(`  ${type.padEnd(20)} ${count}`);
    }
    console.log();

    // Show parse errors if any
    if (stats.failedLines > 0) {
      console.log('❌ Parse Errors:');
      console.log('─'.repeat(60));
      const errors = parser.getParseErrors();
      errors.slice(0, 5).forEach(err => {
        console.log(`  Line ${err.lineNumber}: ${err.error}`);
      });
      if (errors.length > 5) {
        console.log(`  ... and ${errors.length - 5} more errors`);
      }
      console.log();
    }

    // Test data extraction methods
    console.log('💬 Message Extraction:');
    console.log('─'.repeat(60));

    const lastUserMessage = parser.getLastUserMessage();
    console.log(`Last user message: ${lastUserMessage ? `"${lastUserMessage.substring(0, 100)}..."` : '(none)'}`);
    console.log();

    const lastAssistantMessage = parser.getLastAssistantMessage();
    console.log(`Last assistant message: ${lastAssistantMessage ? `"${lastAssistantMessage.substring(0, 100)}..."` : '(none)'}`);
    console.log();

    // Token usage
    const tokenUsage = parser.getTotalTokenUsage();
    console.log('💰 Token Usage:');
    console.log('─'.repeat(60));
    console.log(`Input tokens:          ${formatTokens(tokenUsage.inputTokens)}`);
    console.log(`Output tokens:         ${formatTokens(tokenUsage.outputTokens)}`);
    console.log(`Cache creation tokens: ${formatTokens(tokenUsage.cacheCreationTokens)}`);
    console.log(`Cache read tokens:     ${formatTokens(tokenUsage.cacheReadTokens)}`);
    console.log(`Total tokens:          ${formatTokens(tokenUsage.inputTokens + tokenUsage.outputTokens)}`);
    console.log();

    // Tool use history
    const toolUses = parser.getToolUseHistory();
    console.log('🔧 Tool Use History:');
    console.log('─'.repeat(60));
    if (toolUses.length > 0) {
      console.log(`Total tool uses: ${toolUses.length}\n`);

      // Group by tool name
      const toolCounts = toolUses.reduce((acc, tool) => {
        acc[tool.name] = (acc[tool.name] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

      console.log('Tools used:');
      for (const [name, count] of Object.entries(toolCounts).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${name.padEnd(30)} ${count}x`);
      }
    } else {
      console.log('(no tool uses found)');
    }
    console.log();

    // System entries
    const systemEntries = parser.getSystemEntries();
    if (systemEntries.length > 0) {
      console.log('⚠️  System Entries:');
      console.log('─'.repeat(60));
      console.log(`Found ${systemEntries.length} system entries`);
      systemEntries.slice(0, 3).forEach(entry => {
        console.log(`  [${entry.level || 'info'}] ${entry.content.substring(0, 80)}...`);
      });
      if (systemEntries.length > 3) {
        console.log(`  ... and ${systemEntries.length - 3} more`);
      }
      console.log();
    }

    // Summary entries
    const summaryEntries = parser.getSummaryEntries();
    if (summaryEntries.length > 0) {
      console.log('📝 Summary Entries:');
      console.log('─'.repeat(60));
      console.log(`Found ${summaryEntries.length} summary entries`);
      summaryEntries.forEach((entry, i) => {
        console.log(`\nSummary ${i + 1}:`);
        console.log(entry.summary.substring(0, 200) + '...');
      });
      console.log();
    }

    // Queue operations
    const queueOps = parser.getQueueOperationEntries();
    if (queueOps.length > 0) {
      console.log('🔄 Queue Operations:');
      console.log('─'.repeat(60));
      const enqueues = queueOps.filter(op => op.operation === 'enqueue').length;
      const dequeues = queueOps.filter(op => op.operation === 'dequeue').length;
      console.log(`Enqueue operations: ${enqueues}`);
      console.log(`Dequeue operations: ${dequeues}`);
      console.log();
    }

    console.log('✅ Validation complete!\n');

  } catch (error) {
    console.error('❌ Error parsing transcript:', error);
    process.exit(1);
  }
}

main();
