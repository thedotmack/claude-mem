/**
 * Context Injection Utilities
 *
 * Utilities for Endless Mode v7.1:
 * - Clear tool inputs from transcript to save tokens
 * - Format observations as markdown for additionalContext field
 */

import { readFile, writeFile } from 'fs/promises';
import { ObservationRow } from '../services/sqlite/types.js';

/**
 * Clears the tool input for a specific tool_use_id in the transcript.
 * This saves tokens by removing large tool inputs after observations are captured.
 *
 * @param transcriptPath - Absolute path to the transcript JSON file
 * @param toolUseId - The tool_use_id to find and clear
 * @returns Number of tokens saved (estimated as input length / 4)
 */
export async function clearToolInputInTranscript(
  transcriptPath: string,
  toolUseId: string
): Promise<number> {
  let tokensSaved = 0;

  try {
    const transcriptContent = await readFile(transcriptPath, 'utf-8');
    const lines = transcriptContent.trim().split('\n');

    // Parse each JSONL line
    let modified = false;
    const updatedLines: string[] = [];

    for (const line of lines) {
      if (!line.trim()) {
        updatedLines.push(line);
        continue;
      }

      try {
        const message = JSON.parse(line);

        // Check if this message has tool_use content
        if (message.message?.content && Array.isArray(message.message.content)) {
          for (const block of message.message.content) {
            if (block.type === 'tool_use' && block.id === toolUseId) {
              if (block.input && Object.keys(block.input).length > 0) {
                // Estimate tokens saved (rough: 1 token ≈ 4 chars)
                const inputStr = JSON.stringify(block.input);
                tokensSaved = Math.floor(inputStr.length / 4);

                // Clear the input
                block.input = {};
                modified = true;
              }
            }
          }
        }

        updatedLines.push(JSON.stringify(message));
      } catch (parseError) {
        // Keep malformed lines as-is
        updatedLines.push(line);
      }
    }

    if (modified) {
      await writeFile(transcriptPath, updatedLines.join('\n') + '\n', 'utf-8');
    }
  } catch (error: any) {
    // Don't throw - this is a token optimization, not critical
    console.error(`Failed to clear tool input in transcript: ${error.message}`);
  }

  return tokensSaved;
}

/**
 * Format an observation as markdown for injection into Claude's context
 *
 * @param obs - Observation row from database
 * @returns Formatted markdown string
 */
export function formatObservationAsMarkdown(obs: ObservationRow): string {
  const typeEmoji: Record<ObservationRow['type'], string> = {
    decision: '⚖️',
    bugfix: '🔴',
    feature: '🟣',
    refactor: '🔄',
    discovery: '🔵',
    change: '✅'
  };

  const emoji = typeEmoji[obs.type] || '📝';

  let markdown = `**#${obs.id}** ${emoji} **${obs.title || 'Observation'}**\n\n`;

  if (obs.subtitle) {
    markdown += `${obs.subtitle}\n\n`;
  }

  if (obs.narrative) {
    markdown += `${obs.narrative}\n\n`;
  }

  if (obs.facts) {
    try {
      const facts = JSON.parse(obs.facts);
      if (facts.length > 0) {
        markdown += `**Facts:**\n${facts.map((f: string) => `- ${f}`).join('\n')}\n\n`;
      }
    } catch {
      // Skip malformed facts
    }
  }

  if (obs.concepts) {
    try {
      const concepts = JSON.parse(obs.concepts);
      if (concepts.length > 0) {
        markdown += `**Concepts:** ${concepts.join(', ')}\n\n`;
      }
    } catch {
      // Skip malformed concepts
    }
  }

  const filesRead = obs.files_read ? JSON.parse(obs.files_read) : [];
  const filesModified = obs.files_modified ? JSON.parse(obs.files_modified) : [];

  if (filesRead.length > 0 || filesModified.length > 0) {
    markdown += `**Files:**\n`;
    if (filesRead.length > 0) {
      markdown += `- Read: ${filesRead.join(', ')}\n`;
    }
    if (filesModified.length > 0) {
      markdown += `- Modified: ${filesModified.join(', ')}\n`;
    }
    markdown += '\n';
  }

  markdown += `Read: ~${Math.ceil((obs.text?.length || 0) / 4)}, Work: 🔍 ${obs.discovery_tokens}`;

  return `<claude-mem-context>\n${markdown.trim()}\n</claude-mem-context>`;
}
