#!/usr/bin/env tsx
/**
 * Debug Transcript Structure
 * Examines the first few entries to understand the conversation flow
 */

import { TranscriptParser } from '../src/utils/transcript-parser.js';

const transcriptPath = process.argv[2];

if (!transcriptPath) {
  console.error('Usage: tsx scripts/debug-transcript-structure.ts <path-to-transcript.jsonl>');
  process.exit(1);
}

const parser = new TranscriptParser(transcriptPath);
const entries = parser.getAllEntries();

console.log(`Total entries: ${entries.length}\n`);

// Count entry types
const typeCounts: Record<string, number> = {};
for (const entry of entries) {
  typeCounts[entry.type] = (typeCounts[entry.type] || 0) + 1;
}

console.log('Entry types:');
for (const [type, count] of Object.entries(typeCounts)) {
  console.log(`  ${type}: ${count}`);
}

// Find first user and assistant entries
const firstUser = entries.find(e => e.type === 'user');
const firstAssistant = entries.find(e => e.type === 'assistant');

if (firstUser) {
  const userIndex = entries.indexOf(firstUser);
  console.log(`\n\n=== First User Entry (index ${userIndex}) ===`);
  console.log(`Timestamp: ${firstUser.timestamp}`);
  if (typeof firstUser.content === 'string') {
    console.log(`Content (string): ${firstUser.content.substring(0, 200)}...`);
  } else if (Array.isArray(firstUser.content)) {
    console.log(`Content blocks: ${firstUser.content.length}`);
    for (const block of firstUser.content) {
      if (block.type === 'text') {
        console.log(`  - text: ${(block as any).text?.substring(0, 200)}...`);
      } else {
        console.log(`  - ${block.type}`);
      }
    }
  }
}

if (firstAssistant) {
  const assistantIndex = entries.indexOf(firstAssistant);
  console.log(`\n\n=== First Assistant Entry (index ${assistantIndex}) ===`);
  console.log(`Timestamp: ${firstAssistant.timestamp}`);
  if (Array.isArray(firstAssistant.content)) {
    console.log(`Content blocks: ${firstAssistant.content.length}`);
    for (const block of firstAssistant.content) {
      if (block.type === 'text') {
        console.log(`  - text: ${(block as any).text?.substring(0, 200)}...`);
      } else if (block.type === 'thinking') {
        console.log(`  - thinking: ${(block as any).thinking?.substring(0, 200)}...`);
      } else if (block.type === 'tool_use') {
        console.log(`  - tool_use: ${(block as any).name}`);
      }
    }
  }
}

// Find a few more user/assistant pairs
console.log('\n\n=== First 3 Conversation Exchanges ===\n');

let userCount = 0;
let assistantCount = 0;
let exchangeNum = 0;

for (const entry of entries) {
  if (entry.type === 'user') {
    userCount++;
    if (userCount <= 3) {
      exchangeNum++;
      console.log(`\n--- Exchange ${exchangeNum}: USER ---`);
      if (typeof entry.content === 'string') {
        console.log(entry.content.substring(0, 150) + (entry.content.length > 150 ? '...' : ''));
      } else if (Array.isArray(entry.content)) {
        const textBlock = entry.content.find((b: any) => b.type === 'text');
        if (textBlock) {
          const text = (textBlock as any).text || '';
          console.log(text.substring(0, 150) + (text.length > 150 ? '...' : ''));
        }
      }
    }
  } else if (entry.type === 'assistant' && userCount <= 3) {
    assistantCount++;
    if (Array.isArray(entry.content)) {
      const textBlock = entry.content.find((b: any) => b.type === 'text');
      const toolUses = entry.content.filter((b: any) => b.type === 'tool_use');

      console.log(`\n--- Exchange ${exchangeNum}: ASSISTANT ---`);
      if (textBlock) {
        const text = (textBlock as any).text || '';
        console.log(text.substring(0, 150) + (text.length > 150 ? '...' : ''));
      }
      if (toolUses.length > 0) {
        console.log(`\nTools used: ${toolUses.map((t: any) => t.name).join(', ')}`);
      }
    }
  }

  if (userCount >= 3 && assistantCount >= 3) break;
}
