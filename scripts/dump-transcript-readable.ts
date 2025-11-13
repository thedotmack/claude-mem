#!/usr/bin/env tsx
/**
 * Simple 1:1 transcript dump in readable markdown format
 * Shows exactly what's in the transcript, chronologically
 */

import { TranscriptParser } from '../src/utils/transcript-parser.js';
import { writeFileSync } from 'fs';

const transcriptPath = process.argv[2];

if (!transcriptPath) {
  console.error('Usage: tsx scripts/dump-transcript-readable.ts <path-to-transcript.jsonl>');
  process.exit(1);
}

const parser = new TranscriptParser(transcriptPath);
const entries = parser.getAllEntries();

let output = '# Transcript Dump\n\n';
output += `Total entries: ${entries.length}\n\n`;
output += '---\n\n';

let entryNum = 0;

for (const entry of entries) {
  entryNum++;

  // Skip file-history-snapshot and summary entries for now
  if (entry.type === 'file-history-snapshot' || entry.type === 'summary') continue;

  output += `## Entry ${entryNum}: ${entry.type.toUpperCase()}\n`;
  output += `**Timestamp:** ${entry.timestamp}\n\n`;

  if (entry.type === 'user') {
    const content = entry.message.content;

    if (typeof content === 'string') {
      output += `**Content:**\n\`\`\`\n${content}\n\`\`\`\n\n`;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text') {
          output += `**Text:**\n\`\`\`\n${(block as any).text}\n\`\`\`\n\n`;
        } else if (block.type === 'tool_result') {
          output += `**Tool Result (${(block as any).tool_use_id}):**\n`;
          const resultContent = (block as any).content;
          if (typeof resultContent === 'string') {
            const preview = resultContent.substring(0, 500);
            output += `\`\`\`\n${preview}${resultContent.length > 500 ? '\n...(truncated)' : ''}\n\`\`\`\n\n`;
          } else {
            output += `\`\`\`json\n${JSON.stringify(resultContent, null, 2).substring(0, 500)}\n\`\`\`\n\n`;
          }
        }
      }
    }
  }

  if (entry.type === 'assistant') {
    const content = entry.message.content;

    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text') {
          output += `**Text:**\n\`\`\`\n${(block as any).text}\n\`\`\`\n\n`;
        } else if (block.type === 'thinking') {
          output += `**Thinking:**\n\`\`\`\n${(block as any).thinking}\n\`\`\`\n\n`;
        } else if (block.type === 'tool_use') {
          const tool = block as any;
          output += `**Tool Use: ${tool.name}**\n`;
          output += `\`\`\`json\n${JSON.stringify(tool.input, null, 2)}\n\`\`\`\n\n`;
        }
      }
    }

    // Show token usage if available
    const usage = entry.message.usage;
    if (usage) {
      output += `**Usage:**\n`;
      output += `- Input: ${usage.input_tokens || 0}\n`;
      output += `- Output: ${usage.output_tokens || 0}\n`;
      output += `- Cache creation: ${usage.cache_creation_input_tokens || 0}\n`;
      output += `- Cache read: ${usage.cache_read_input_tokens || 0}\n\n`;
    }
  }

  output += '---\n\n';

  // Limit to first 20 entries to keep file manageable
  if (entryNum >= 20) {
    output += `\n_Remaining ${entries.length - 20} entries omitted for brevity_\n`;
    break;
  }
}

const outputPath = '/Users/alexnewman/Scripts/claude-mem/docs/context/transcript-dump.md';
writeFileSync(outputPath, output, 'utf-8');

console.log(`\nTranscript dumped to: ${outputPath}`);
console.log(`Showing first 20 conversation entries (skipped file-history-snapshot and summary types)\n`);
