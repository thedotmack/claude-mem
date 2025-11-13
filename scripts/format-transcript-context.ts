#!/usr/bin/env tsx
/**
 * Format Transcript Context
 *
 * Parses a Claude Code transcript and formats it to show rich contextual data
 * that could be used for improved observation generation.
 */

import { TranscriptParser } from '../src/utils/transcript-parser.js';
import { writeFileSync } from 'fs';
import { basename } from 'path';

interface ConversationTurn {
  turnNumber: number;
  userMessage?: {
    content: string;
    timestamp: string;
  };
  assistantMessage?: {
    textContent: string;
    thinkingContent?: string;
    toolUses: Array<{
      name: string;
      input: any;
      timestamp: string;
    }>;
    timestamp: string;
  };
  toolResults?: Array<{
    toolName: string;
    result: any;
    timestamp: string;
  }>;
}

function extractConversationTurns(parser: TranscriptParser): ConversationTurn[] {
  const entries = parser.getAllEntries();
  const turns: ConversationTurn[] = [];
  let currentTurn: ConversationTurn | null = null;
  let turnNumber = 0;

  for (const entry of entries) {
    // User messages start a new turn
    if (entry.type === 'user') {
      // If previous turn exists, push it
      if (currentTurn) {
        turns.push(currentTurn);
      }

      // Start new turn
      turnNumber++;
      currentTurn = {
        turnNumber,
        toolResults: []
      };

      // Extract user text (skip tool results)
      if (typeof entry.content === 'string') {
        currentTurn.userMessage = {
          content: entry.content,
          timestamp: entry.timestamp
        };
      } else if (Array.isArray(entry.content)) {
        const textContent = entry.content
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text)
          .join('\n');

        if (textContent.trim()) {
          currentTurn.userMessage = {
            content: textContent,
            timestamp: entry.timestamp
          };
        }

        // Extract tool results
        const toolResults = entry.content.filter((c: any) => c.type === 'tool_result');
        for (const result of toolResults) {
          currentTurn.toolResults!.push({
            toolName: result.tool_use_id || 'unknown',
            result: result.content,
            timestamp: entry.timestamp
          });
        }
      }
    }

    // Assistant messages
    if (entry.type === 'assistant' && currentTurn) {
      if (!Array.isArray(entry.content)) continue;

      const textBlocks = entry.content.filter((c: any) => c.type === 'text');
      const thinkingBlocks = entry.content.filter((c: any) => c.type === 'thinking');
      const toolUseBlocks = entry.content.filter((c: any) => c.type === 'tool_use');

      currentTurn.assistantMessage = {
        textContent: textBlocks.map((c: any) => c.text).join('\n'),
        thinkingContent: thinkingBlocks.map((c: any) => c.thinking).join('\n'),
        toolUses: toolUseBlocks.map((t: any) => ({
          name: t.name,
          input: t.input,
          timestamp: entry.timestamp
        })),
        timestamp: entry.timestamp
      };
    }
  }

  // Push last turn
  if (currentTurn) {
    turns.push(currentTurn);
  }

  return turns;
}

function formatTurnToMarkdown(turn: ConversationTurn): string {
  let md = '';

  md += `## Turn ${turn.turnNumber}\n\n`;

  // User message
  if (turn.userMessage) {
    md += `### 👤 User Request\n`;
    md += `**Time:** ${new Date(turn.userMessage.timestamp).toLocaleString()}\n\n`;
    md += '```\n';
    md += turn.userMessage.content.substring(0, 500);
    if (turn.userMessage.content.length > 500) {
      md += '\n... (truncated)';
    }
    md += '\n```\n\n';
  }

  // Assistant response
  if (turn.assistantMessage) {
    md += `### 🤖 Assistant Response\n`;
    md += `**Time:** ${new Date(turn.assistantMessage.timestamp).toLocaleString()}\n\n`;

    // Text content
    if (turn.assistantMessage.textContent.trim()) {
      md += '**Response:**\n```\n';
      md += turn.assistantMessage.textContent.substring(0, 500);
      if (turn.assistantMessage.textContent.length > 500) {
        md += '\n... (truncated)';
      }
      md += '\n```\n\n';
    }

    // Thinking
    if (turn.assistantMessage.thinkingContent?.trim()) {
      md += '**Thinking:**\n```\n';
      md += turn.assistantMessage.thinkingContent.substring(0, 300);
      if (turn.assistantMessage.thinkingContent.length > 300) {
        md += '\n... (truncated)';
      }
      md += '\n```\n\n';
    }

    // Tool uses
    if (turn.assistantMessage.toolUses.length > 0) {
      md += `**Tools Used:** ${turn.assistantMessage.toolUses.length}\n\n`;
      for (const tool of turn.assistantMessage.toolUses) {
        md += `- **${tool.name}**\n`;
        md += `  \`\`\`json\n`;
        const inputStr = JSON.stringify(tool.input, null, 2);
        md += inputStr.substring(0, 200);
        if (inputStr.length > 200) {
          md += '\n  ... (truncated)';
        }
        md += '\n  ```\n';
      }
      md += '\n';
    }
  }

  // Tool results summary
  if (turn.toolResults && turn.toolResults.length > 0) {
    md += `**Tool Results:** ${turn.toolResults.length} results received\n\n`;
  }

  md += '---\n\n';
  return md;
}

function formatTranscriptToMarkdown(transcriptPath: string): string {
  const parser = new TranscriptParser(transcriptPath);
  const turns = extractConversationTurns(parser);
  const stats = parser.getParseStats();
  const tokens = parser.getTotalTokenUsage();

  let md = `# Transcript Context Analysis\n\n`;
  md += `**File:** ${basename(transcriptPath)}\n`;
  md += `**Parsed:** ${new Date().toLocaleString()}\n\n`;

  md += `## Statistics\n\n`;
  md += `- Total entries: ${stats.totalLines}\n`;
  md += `- Successfully parsed: ${stats.parsedEntries}\n`;
  md += `- Failed lines: ${stats.failedLines}\n`;
  md += `- Conversation turns: ${turns.length}\n\n`;

  md += `## Token Usage\n\n`;
  md += `- Input tokens: ${tokens.inputTokens.toLocaleString()}\n`;
  md += `- Output tokens: ${tokens.outputTokens.toLocaleString()}\n`;
  md += `- Cache creation: ${tokens.cacheCreationTokens.toLocaleString()}\n`;
  md += `- Cache read: ${tokens.cacheReadTokens.toLocaleString()}\n`;
  const totalTokens = tokens.inputTokens + tokens.outputTokens;
  md += `- Total: ${totalTokens.toLocaleString()}\n\n`;

  md += `---\n\n`;
  md += `# Conversation Turns\n\n`;

  // Format each turn
  for (const turn of turns.slice(0, 20)) { // Limit to first 20 turns for readability
    md += formatTurnToMarkdown(turn);
  }

  if (turns.length > 20) {
    md += `\n_... ${turns.length - 20} more turns omitted for brevity_\n`;
  }

  return md;
}

// Main execution
const transcriptPath = process.argv[2];

if (!transcriptPath) {
  console.error('Usage: tsx scripts/format-transcript-context.ts <path-to-transcript.jsonl>');
  process.exit(1);
}

console.log(`Parsing transcript: ${transcriptPath}`);

const markdown = formatTranscriptToMarkdown(transcriptPath);
const outputPath = transcriptPath.replace('.jsonl', '-formatted.md');

writeFileSync(outputPath, markdown, 'utf-8');

console.log(`\nFormatted transcript written to: ${outputPath}`);
console.log(`\nOpen with: cat "${outputPath}"\n`);
