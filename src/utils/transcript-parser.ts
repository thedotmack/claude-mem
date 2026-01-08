/**
 * TranscriptParser - Properly parse Claude Code transcript JSONL files
 * Handles all transcript entry types based on validated model
 */

import { readFileSync } from 'fs';
import { logger } from './logger.js';
import type {
  TranscriptEntry,
  UserTranscriptEntry,
  AssistantTranscriptEntry,
  SummaryTranscriptEntry,
  SystemTranscriptEntry,
  QueueOperationTranscriptEntry,
  ContentItem,
  TextContent,
} from '../types/transcript.js';

export interface ParseStats {
  totalLines: number;
  parsedEntries: number;
  failedLines: number;
  entriesByType: Record<string, number>;
  failureRate: number;
}

export class TranscriptParser {
  private entries: TranscriptEntry[] = [];
  private parseErrors: Array<{ lineNumber: number; error: string }> = [];

  constructor(transcriptPath: string) {
    this.parseTranscript(transcriptPath);
  }

  private parseTranscript(transcriptPath: string): void {
    const content = readFileSync(transcriptPath, 'utf-8').trim();
    if (!content) return;

    const lines = content.split('\n');

    lines.forEach((line, index) => {
      try {
        const entry = JSON.parse(line) as TranscriptEntry;
        this.entries.push(entry);
      } catch (error) {
        logger.debug('PARSER', 'Failed to parse transcript line', { lineNumber: index + 1 }, error as Error);
        this.parseErrors.push({
          lineNumber: index + 1,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    // Log summary if there were parse errors
    if (this.parseErrors.length > 0) {
      logger.error('PARSER', `Failed to parse ${this.parseErrors.length} lines`, {
        path: transcriptPath,
        totalLines: lines.length,
        errorCount: this.parseErrors.length
      });
    }
  }

  /**
   * Get all entries of a specific type
   */
  getEntriesByType<T extends TranscriptEntry>(type: T['type']): T[] {
    return this.entries.filter((e) => e.type === type) as T[];
  }

  /**
   * Get all user entries
   */
  getUserEntries(): UserTranscriptEntry[] {
    return this.getEntriesByType<UserTranscriptEntry>('user');
  }

  /**
   * Get all assistant entries
   */
  getAssistantEntries(): AssistantTranscriptEntry[] {
    return this.getEntriesByType<AssistantTranscriptEntry>('assistant');
  }

  /**
   * Get all summary entries
   */
  getSummaryEntries(): SummaryTranscriptEntry[] {
    return this.getEntriesByType<SummaryTranscriptEntry>('summary');
  }

  /**
   * Get all system entries
   */
  getSystemEntries(): SystemTranscriptEntry[] {
    return this.getEntriesByType<SystemTranscriptEntry>('system');
  }

  /**
   * Get all queue operation entries
   */
  getQueueOperationEntries(): QueueOperationTranscriptEntry[] {
    return this.getEntriesByType<QueueOperationTranscriptEntry>('queue-operation');
  }

  /**
   * Get last entry of a specific type
   */
  getLastEntryByType<T extends TranscriptEntry>(type: T['type']): T | null {
    const entries = this.getEntriesByType<T>(type);
    return entries.length > 0 ? entries[entries.length - 1] : null;
  }

  /**
   * Extract text content from content items
   */
  private extractTextFromContent(content: string | ContentItem[]): string {
    if (typeof content === 'string') {
      return content;
    }

    if (Array.isArray(content)) {
      return content
        .filter((item): item is TextContent => item.type === 'text')
        .map((item) => item.text)
        .join('\n');
    }

    return '';
  }

  /**
   * Get last user message text (finds last entry with actual text content)
   */
  getLastUserMessage(): string {
    const userEntries = this.getUserEntries();

    // Iterate backward to find the last user message with text content
    for (let i = userEntries.length - 1; i >= 0; i--) {
      const entry = userEntries[i];
      if (!entry?.message?.content) continue;

      const text = this.extractTextFromContent(entry.message.content);
      if (text) return text;
    }

    return '';
  }

  /**
   * Get last assistant message text (finds last entry with text content, with optional system-reminder filtering)
   */
  getLastAssistantMessage(filterSystemReminders = true): string {
    const assistantEntries = this.getAssistantEntries();

    // Iterate backward to find the last assistant message with text content
    for (let i = assistantEntries.length - 1; i >= 0; i--) {
      const entry = assistantEntries[i];
      if (!entry?.message?.content) continue;

      let text = this.extractTextFromContent(entry.message.content);
      if (!text) continue;

      if (filterSystemReminders) {
        // Filter out system-reminder tags and their content
        text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
        // Clean up excessive whitespace
        text = text.replace(/\n{3,}/g, '\n\n').trim();
      }

      if (text) return text;
    }

    return '';
  }

  /**
   * Get all tool use operations from assistant entries
   */
  getToolUseHistory(): Array<{ name: string; timestamp: string; input: any }> {
    const toolUses: Array<{ name: string; timestamp: string; input: any }> = [];

    for (const entry of this.getAssistantEntries()) {
      if (Array.isArray(entry.message.content)) {
        for (const item of entry.message.content) {
          if (item.type === 'tool_use') {
            toolUses.push({
              name: item.name,
              timestamp: entry.timestamp,
              input: item.input,
            });
          }
        }
      }
    }

    return toolUses;
  }

  /**
   * Get total token usage across all assistant messages
   */
  getTotalTokenUsage(): {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
  } {
    const assistantEntries = this.getAssistantEntries();

    return assistantEntries.reduce(
      (acc, entry) => {
        const usage = entry.message.usage;
        if (usage) {
          acc.inputTokens += usage.input_tokens || 0;
          acc.outputTokens += usage.output_tokens || 0;
          acc.cacheCreationTokens += usage.cache_creation_input_tokens || 0;
          acc.cacheReadTokens += usage.cache_read_input_tokens || 0;
        }
        return acc;
      },
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      }
    );
  }

  /**
   * Get parse statistics
   */
  getParseStats(): ParseStats {
    const entriesByType: Record<string, number> = {};

    for (const entry of this.entries) {
      entriesByType[entry.type] = (entriesByType[entry.type] || 0) + 1;
    }

    const totalLines = this.entries.length + this.parseErrors.length;

    return {
      totalLines,
      parsedEntries: this.entries.length,
      failedLines: this.parseErrors.length,
      entriesByType,
      failureRate: totalLines > 0 ? this.parseErrors.length / totalLines : 0,
    };
  }

  /**
   * Get parse errors
   */
  getParseErrors(): Array<{ lineNumber: number; error: string }> {
    return this.parseErrors;
  }

  /**
   * Get all entries (raw)
   */
  getAllEntries(): TranscriptEntry[] {
    return this.entries;
  }
}
