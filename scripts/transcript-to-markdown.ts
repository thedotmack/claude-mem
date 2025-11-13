#!/usr/bin/env tsx
/**
 * Transcript to Markdown - Complete 1:1 representation
 * Shows ALL available context data from a Claude Code transcript
 */

import { TranscriptParser } from '../src/utils/transcript-parser.js';
import type { UserTranscriptEntry, AssistantTranscriptEntry, ToolResultContent } from '../types/transcript.js';
import { writeFileSync } from 'fs';
import { basename } from 'path';

const transcriptPath = process.argv[2];
const maxTurns = process.argv[3] ? parseInt(process.argv[3]) : 20;

if (!transcriptPath) {
  console.error('Usage: tsx scripts/transcript-to-markdown.ts <path-to-transcript.jsonl> [max-turns]');
  process.exit(1);
}

/**
 * Truncate string to max length, adding ellipsis if needed
 */
function truncate(str: string, maxLen: number = 500): string {
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen) + '\n... [truncated]';
}

/**
 * Format tool result content for display
 */
function formatToolResult(result: ToolResultContent): string {
  if (typeof result.content === 'string') {
    // Try to parse as JSON for better formatting
    try {
      const parsed = JSON.parse(result.content);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return truncate(result.content);
    }
  }

  if (Array.isArray(result.content)) {
    // Handle array of content items - extract text and parse if JSON
    const formatted = result.content.map((item: any) => {
      if (item.type === 'text' && item.text) {
        try {
          const parsed = JSON.parse(item.text);
          return JSON.stringify(parsed, null, 2);
        } catch {
          return item.text;
        }
      }
      return JSON.stringify(item, null, 2);
    }).join('\n\n');

    return formatted;
  }

  return '[unknown result type]';
}

const parser = new TranscriptParser(transcriptPath);
const entries = parser.getAllEntries();
const stats = parser.getParseStats();

let output = `# Transcript: ${basename(transcriptPath)}\n\n`;
output += `**Generated:** ${new Date().toLocaleString()}\n`;
output += `**Total Entries:** ${stats.parsedEntries}\n`;
output += `**Entry Types:** ${JSON.stringify(stats.entriesByType, null, 2)}\n`;
output += `**Showing:** First ${maxTurns} conversation turns\n\n`;

output += `---\n\n`;

let turnNumber = 0;
let inTurn = false;

for (const entry of entries) {
  // Skip summary and file-history-snapshot entries
  if (entry.type === 'summary' || entry.type === 'file-history-snapshot') continue;

  // USER MESSAGE
  if (entry.type === 'user') {
    const userEntry = entry as UserTranscriptEntry;

    turnNumber++;
    if (turnNumber > maxTurns) break;

    inTurn = true;
    output += `## Turn ${turnNumber}\n\n`;
    output += `### 👤 User\n`;
    output += `**Timestamp:** ${userEntry.timestamp}\n`;
    output += `**UUID:** ${userEntry.uuid}\n`;
    output += `**Session ID:** ${userEntry.sessionId}\n`;
    output += `**CWD:** ${userEntry.cwd}\n\n`;

    // Extract user message text
    if (typeof userEntry.message.content === 'string') {
      output += userEntry.message.content + '\n\n';
    } else if (Array.isArray(userEntry.message.content)) {
      const textBlocks = userEntry.message.content.filter((c) => c.type === 'text');
      if (textBlocks.length > 0) {
        const text = textBlocks.map((b: any) => b.text).join('\n');
        output += text + '\n\n';
      }

      // Show ACTUAL tool results with their data
      const toolResults = userEntry.message.content.filter((c): c is ToolResultContent => c.type === 'tool_result');
      if (toolResults.length > 0) {
        output += `**Tool Results Submitted (${toolResults.length}):**\n\n`;
        for (const result of toolResults) {
          output += `- **Tool Use ID:** \`${result.tool_use_id}\`\n`;
          if (result.is_error) {
            output += `  **ERROR:**\n`;
          }
          output += `  \`\`\`json\n`;
          output += `  ${formatToolResult(result)}\n`;
          output += `  \`\`\`\n\n`;
        }
      }
    }
  }

  // ASSISTANT MESSAGE
  if (entry.type === 'assistant' && inTurn) {
    const assistantEntry = entry as AssistantTranscriptEntry;

    output += `### 🤖 Assistant\n`;
    output += `**Timestamp:** ${assistantEntry.timestamp}\n`;
    output += `**UUID:** ${assistantEntry.uuid}\n`;
    output += `**Model:** ${assistantEntry.message.model}\n`;
    output += `**Stop Reason:** ${assistantEntry.message.stop_reason || 'N/A'}\n\n`;

    if (!Array.isArray(assistantEntry.message.content)) {
      output += `*[No content]*\n\n`;
      continue;
    }

    const content = assistantEntry.message.content;

    // 1. Thinking blocks (show first, as they happen first in reasoning)
    const thinkingBlocks = content.filter((c) => c.type === 'thinking');
    if (thinkingBlocks.length > 0) {
      output += `**💭 Thinking:**\n\n`;
      for (const block of thinkingBlocks) {
        const thinking = (block as any).thinking;
        // Format thinking with proper line breaks and indentation
        const formattedThinking = thinking
          .split('\n')
          .map((line: string) => line.trimEnd())
          .join('\n');

        output += '> ';
        output += formattedThinking.replace(/\n/g, '\n> ');
        output += '\n\n';
      }
    }

    // 2. Text responses
    const textBlocks = content.filter((c) => c.type === 'text');
    if (textBlocks.length > 0) {
      output += `**Response:**\n\n`;
      for (const block of textBlocks) {
        output += (block as any).text + '\n\n';
      }
    }

    // 3. Tool uses - show complete input
    const toolUseBlocks = content.filter((c) => c.type === 'tool_use');
    if (toolUseBlocks.length > 0) {
      output += `**🔧 Tools Used (${toolUseBlocks.length}):**\n\n`;
      for (const tool of toolUseBlocks) {
        const t = tool as any;
        output += `- **${t.name}** (ID: \`${t.id}\`)\n`;
        output += `  \`\`\`json\n`;
        output += `  ${JSON.stringify(t.input, null, 2)}\n`;
        output += `  \`\`\`\n\n`;
      }
    }

    // 4. Token usage
    if (assistantEntry.message.usage) {
      const usage = assistantEntry.message.usage;
      output += `**📊 Token Usage:**\n`;
      output += `- Input: ${usage.input_tokens || 0}\n`;
      output += `- Output: ${usage.output_tokens || 0}\n`;
      if (usage.cache_creation_input_tokens) {
        output += `- Cache creation: ${usage.cache_creation_input_tokens}\n`;
      }
      if (usage.cache_read_input_tokens) {
        output += `- Cache read: ${usage.cache_read_input_tokens}\n`;
      }
      output += '\n';
    }

    output += `---\n\n`;
    inTurn = false;
  }
}

if (turnNumber < (stats.entriesByType['user'] || 0)) {
  output += `\n*... ${(stats.entriesByType['user'] || 0) - turnNumber} more turns not shown*\n`;
}

// Write output
const outputPath = transcriptPath.replace('.jsonl', '-complete.md');
writeFileSync(outputPath, output, 'utf-8');

console.log(`\nComplete transcript written to: ${outputPath}`);
console.log(`Turns shown: ${Math.min(turnNumber, maxTurns)} of ${stats.entriesByType['user'] || 0}\n`);
