#!/usr/bin/env tsx
/**
 * Extract Rich Context Examples
 * Shows what data we have available for memory worker using TranscriptParser API
 */

import { TranscriptParser } from '../src/utils/transcript-parser.js';
import { writeFileSync } from 'fs';
import type { AssistantTranscriptEntry, UserTranscriptEntry } from '../src/types/transcript.js';

const transcriptPath = process.argv[2];

if (!transcriptPath) {
  console.error('Usage: tsx scripts/extract-rich-context-examples.ts <path-to-transcript.jsonl>');
  process.exit(1);
}

const parser = new TranscriptParser(transcriptPath);

let output = '# Rich Context Examples\n\n';
output += 'This document shows what contextual data is available in transcripts\n';
output += 'that could improve observation generation quality.\n\n';

// Get stats using parser API
const stats = parser.getParseStats();
const tokens = parser.getTotalTokenUsage();

output += `## Statistics\n\n`;
output += `- Total entries: ${stats.parsedEntries}\n`;
output += `- User messages: ${stats.entriesByType['user'] || 0}\n`;
output += `- Assistant messages: ${stats.entriesByType['assistant'] || 0}\n`;
output += `- Token usage: ${(tokens.inputTokens + tokens.outputTokens).toLocaleString()} total\n`;
output += `- Cache efficiency: ${tokens.cacheReadTokens.toLocaleString()} tokens read from cache\n\n`;

// Extract conversation pairs with tool uses
const assistantEntries = parser.getAssistantEntries();
const userEntries = parser.getUserEntries();

output += `## Conversation Flow\n\n`;
output += `This shows how user requests, assistant reasoning, and tool executions flow together.\n`;
output += `This is the rich context currently missing from individual tool observations.\n\n`;

let examplesFound = 0;
const maxExamples = 5;

// Match assistant entries with their preceding user message
for (let i = 0; i < assistantEntries.length && examplesFound < maxExamples; i++) {
  const assistantEntry = assistantEntries[i];
  const content = assistantEntry.message.content;

  if (!Array.isArray(content)) continue;

  // Extract components from assistant message
  const textBlocks = content.filter((c: any) => c.type === 'text');
  const thinkingBlocks = content.filter((c: any) => c.type === 'thinking');
  const toolUseBlocks = content.filter((c: any) => c.type === 'tool_use');

  // Skip if no tools or only MCP tools
  const regularTools = toolUseBlocks.filter((t: any) =>
    !t.name.startsWith('mcp__')
  );

  if (regularTools.length === 0) continue;

  // Find the user message that preceded this assistant response
  let userMessage = '';
  const assistantTimestamp = new Date(assistantEntry.timestamp).getTime();

  for (const userEntry of userEntries) {
    const userTimestamp = new Date(userEntry.timestamp).getTime();
    if (userTimestamp < assistantTimestamp) {
      // Extract user text using parser's helper
      const extractText = (content: any): string => {
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
          return content
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.text)
            .join('\n');
        }
        return '';
      };

      const text = extractText(userEntry.message.content);
      if (text.trim()) {
        userMessage = text;
      }
    }
  }

  examplesFound++;
  output += `---\n\n`;
  output += `### Example ${examplesFound}\n\n`;

  // 1. User Request
  if (userMessage) {
    output += `#### 👤 User Request\n`;
    const preview = userMessage.substring(0, 400);
    output += `\`\`\`\n${preview}${userMessage.length > 400 ? '\n...(truncated)' : ''}\n\`\`\`\n\n`;
  }

  // 2. Assistant's Explanation (what it plans to do)
  if (textBlocks.length > 0) {
    const text = textBlocks.map((b: any) => b.text).join('\n');
    output += `#### 🤖 Assistant's Plan\n`;
    const preview = text.substring(0, 400);
    output += `\`\`\`\n${preview}${text.length > 400 ? '\n...(truncated)' : ''}\n\`\`\`\n\n`;
  }

  // 3. Internal Reasoning (thinking)
  if (thinkingBlocks.length > 0) {
    const thinking = thinkingBlocks.map((b: any) => b.thinking).join('\n');
    output += `#### 💭 Internal Reasoning\n`;
    const preview = thinking.substring(0, 300);
    output += `\`\`\`\n${preview}${thinking.length > 300 ? '\n...(truncated)' : ''}\n\`\`\`\n\n`;
  }

  // 4. Tool Executions
  output += `#### 🔧 Tools Executed (${regularTools.length})\n\n`;
  for (const tool of regularTools) {
    const toolData = tool as any;
    output += `**${toolData.name}**\n`;

    // Show relevant input fields
    const input = toolData.input;
    if (toolData.name === 'Read') {
      output += `- Reading: \`${input.file_path}\`\n`;
    } else if (toolData.name === 'Write') {
      output += `- Writing: \`${input.file_path}\` (${input.content?.length || 0} chars)\n`;
    } else if (toolData.name === 'Edit') {
      output += `- Editing: \`${input.file_path}\`\n`;
    } else if (toolData.name === 'Bash') {
      output += `- Command: \`${input.command}\`\n`;
    } else if (toolData.name === 'Glob') {
      output += `- Pattern: \`${input.pattern}\`\n`;
    } else if (toolData.name === 'Grep') {
      output += `- Searching for: \`${input.pattern}\`\n`;
    } else {
      output += `\`\`\`json\n${JSON.stringify(input, null, 2).substring(0, 200)}\n\`\`\`\n`;
    }
  }
  output += `\n`;

  // Summary of what data is available
  output += `**📊 Data Available for This Exchange:**\n`;
  output += `- User intent: ✅ (${userMessage.length} chars)\n`;
  output += `- Assistant reasoning: ✅ (${textBlocks.reduce((sum, b: any) => sum + b.text.length, 0)} chars)\n`;
  output += `- Thinking process: ${thinkingBlocks.length > 0 ? '✅' : '❌'} ${thinkingBlocks.length > 0 ? `(${thinkingBlocks.reduce((sum, b: any) => sum + b.thinking.length, 0)} chars)` : ''}\n`;
  output += `- Tool executions: ✅ (${regularTools.length} tools)\n`;
  output += `- **Currently sent to memory worker:** Tool inputs/outputs only (no context!) ❌\n\n`;
}

output += `\n---\n\n`;
output += `## Key Insight\n\n`;
output += `Currently, the memory worker receives **isolated tool executions** via save-hook:\n`;
output += `- tool_name: "Read"\n`;
output += `- tool_input: {"file_path": "src/foo.ts"}\n`;
output += `- tool_output: {file contents}\n\n`;
output += `But the transcript contains **rich contextual data**:\n`;
output += `- WHY the tool was used (user's request)\n`;
output += `- WHAT the assistant planned to accomplish\n`;
output += `- HOW it fits into the broader task\n`;
output += `- The assistant's reasoning/thinking\n`;
output += `- Multiple related tools used together\n\n`;
output += `This context would help the memory worker:\n`;
output += `1. Understand if a tool use is meaningful or routine\n`;
output += `2. Generate observations that capture WHY, not just WHAT\n`;
output += `3. Group related tools into coherent actions\n`;
output += `4. Avoid "investigating" - the context is already present\n\n`;

// Write to file
const outputPath = '/Users/alexnewman/Scripts/claude-mem/docs/context/rich-context-examples.md';
writeFileSync(outputPath, output, 'utf-8');

console.log(`\nExtracted ${examplesFound} examples with rich context`);
console.log(`Written to: ${outputPath}\n`);
console.log(`This shows the gap between what's available (rich context) and what's sent (isolated tools)\n`);
