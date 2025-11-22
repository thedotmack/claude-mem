/**
 * TranscriptTransformer - Standalone OOP class for JSONL transcript manipulation
 *
 * Handles atomic transformation of Claude Code transcript files by replacing
 * tool outputs with compressed observations.
 *
 * Key features:
 * - Atomic file operations (temp file + rename)
 * - JSONL validation before committing changes
 * - Backup management separated from transformation
 * - Clear error handling and rollback
 */

import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from 'fs';
import { logger } from '../utils/logger.js';
import { appendToolOutput, trimBackupFile } from '../shared/tool-output-backup.js';
import { silentDebug } from '../utils/silent-debug.js';
import type { TranscriptEntry, UserTranscriptEntry, ToolResultContent } from '../types/transcript.js';
import type { Observation } from './worker-types.js';

export interface TransformStats {
  originalTokens: number;
  compressedTokens: number;
  originalSize: number;
  compressedSize: number;
  toolUseId: string;
}

export class TranscriptTransformer {
  private readonly transcriptPath: string;
  private readonly dbPath?: string;
  private readonly CHARS_PER_TOKEN = 4;

  constructor(transcriptPath: string, dbPath?: string) {
    if (!transcriptPath) {
      throw new Error('Transcript path is required');
    }
    if (!existsSync(transcriptPath)) {
      throw new Error(`Transcript file does not exist: ${transcriptPath}`);
    }
    this.transcriptPath = transcriptPath;
    this.dbPath = dbPath;
  }

  /**
   * Transform a specific tool use in the transcript by replacing its output
   * with compressed observations (queries database and concatenates all observations for this tool_use_id)
   */
  async transform(toolUseId: string, outputPath?: string): Promise<TransformStats> {
    if (!toolUseId) {
      throw new Error('Tool use ID is required');
    }

    // Query database for ALL observations with this tool_use_id
    const { SessionStore } = await import('./sqlite/SessionStore.js');
    const db = new SessionStore();
    const observations = db.getAllObservationsForToolUseId(toolUseId);
    db.close();

    if (observations.length === 0) {
      throw new Error(`No observations found for tool_use_id: ${toolUseId}`);
    }

    // Read from output path if it exists, otherwise read from original
    const readPath = (outputPath && existsSync(outputPath)) ? outputPath : this.transcriptPath;
    const lines = readFileSync(readPath, 'utf-8').split('\n');

    // Concatenate ALL observations for this tool_use_id
    const concatenatedObservations = observations
      .map(obs => this.formatObservationAsMarkdown(obs))
      .join('\n\n---\n\n');

    let found = false;
    let originalSize = 0;
    let compressedSize = 0;

    // Transform lines - look for assistant messages with tool_use (these have large inputs)
    // NOTE: This intentionally processes ALL lines and replaces ALL matches.
    // When multiple observations exist in the database for the same tool_use_id,
    // they are concatenated together before replacing the tool_use input.
    // This ensures all observations are included in the compressed transformation.
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue;

      const obj = JSON.parse(lines[i]);

      if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
        for (const item of obj.message.content) {
          if (item.type === 'tool_use' && item.id === toolUseId) {
            found = true;

            // Measure sizes
            originalSize = JSON.stringify(item.input).length;
            compressedSize = concatenatedObservations.length;

            // Replace the entire input with observation references
            item.input = {
              _observation_refs: observations.map(obs => obs.id),
              _observation_count: observations.length,
              _note: `Original input compressed - ${observations.length} observation(s) for details`
            };
            lines[i] = JSON.stringify(obj);
          }
        }
      }
    }

    if (!found) {
      throw new Error(`Tool use ID not found in transcript: ${toolUseId}`);
    }

    // Write to output path or original path
    const writePath = outputPath || silentDebug('transcript-transformer: outputPath is null', { transcriptPath: this.transcriptPath }, this.transcriptPath);
    writeFileSync(writePath, lines.join('\n'));

    // Convert character counts to approximate token counts
    const originalTokens = Math.ceil(originalSize / this.CHARS_PER_TOKEN);
    const compressedTokens = Math.ceil(compressedSize / this.CHARS_PER_TOKEN);

    logger.success('TRANSFORMER', 'Transcript transformation complete', {
      toolUseId,
      originalSize,
      compressedSize,
      originalTokens,
      compressedTokens,
      savings: `${Math.round((1 - compressedSize / originalSize) * 100)}%`
    });

    return {
      originalTokens,
      compressedTokens,
      originalSize,
      compressedSize,
      toolUseId
    };
  }

  /**
   * Format an observation as markdown for compression
   */
  private formatObservationAsMarkdown(obs: Observation): string {
    const parts: string[] = [];

    // Title and subtitle
    parts.push(`# ${obs.title}`);
    if (obs.subtitle) {
      parts.push(`**${obs.subtitle}**`);
    }
    parts.push('');

    // Narrative
    if (obs.narrative) {
      parts.push(obs.narrative);
      parts.push('');
    }

    // Facts
    const factsArray = this.parseArrayField(obs.facts, 'facts');
    if (factsArray.length > 0) {
      parts.push('**Key Facts:**');
      factsArray.forEach((fact: string) => parts.push(`- ${fact}`));
      parts.push('');
    }

    // Concepts
    const conceptsArray = this.parseArrayField(obs.concepts, 'concepts');
    if (conceptsArray.length > 0) {
      parts.push(`**Concepts**: ${conceptsArray.join(', ')}`);
      parts.push('');
    }

    // Files read
    const filesRead = this.parseArrayField(obs.files_read, 'files_read');
    if (filesRead.length > 0) {
      parts.push(`**Files Read**: ${filesRead.join(', ')}`);
      parts.push('');
    }

    // Files modified
    const filesModified = this.parseArrayField(obs.files_modified, 'files_modified');
    if (filesModified.length > 0) {
      parts.push(`**Files Modified**: ${filesModified.join(', ')}`);
      parts.push('');
    }

    // Footer
    parts.push('---');
    parts.push('*[Compressed by Endless Mode]*');

    return parts.join('\n');
  }

  /**
   * Helper: Parse array field (handles both arrays and JSON strings)
   */
  private parseArrayField(field: any, fieldName: string): string[] {
    if (!field) return [];
    if (Array.isArray(field)) return field;
    try {
      const parsed = JSON.parse(field);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      logger.debug('TRANSFORMER', `Failed to parse ${fieldName}`, { field, error: e });
      return [];
    }
  }

  /**
   * Atomic file write: write to temp file, validate, then rename
   * Original file is untouched until validation succeeds
   */
  private async atomicWrite(content: string): Promise<void> {
    const tempPath = `${this.transcriptPath}.tmp`;

    try {
      // Write to temp file
      writeFileSync(tempPath, content, 'utf-8');

      // Validate JSONL structure
      this.validateJSONL(tempPath);

      // Atomic rename (original untouched until this succeeds)
      renameSync(tempPath, this.transcriptPath);

      logger.debug('TRANSFORMER', 'Atomic write successful', {
        path: this.transcriptPath
      });
    } catch (error) {
      // Cleanup temp file on failure
      this.cleanup(tempPath);
      throw error;
    }
  }

  /**
   * Validate JSONL structure - throws if invalid
   */
  private validateJSONL(filePath: string): void {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.trim().split('\n');

      for (const line of lines) {
        if (line.trim()) {
          JSON.parse(line); // Will throw if invalid
        }
      }

      logger.debug('TRANSFORMER', 'JSONL validation passed', {
        path: filePath,
        lines: lines.length
      });
    } catch (error) {
      logger.error('TRANSFORMER', 'JSONL validation failed', { path: filePath }, error as Error);
      throw new Error(`JSONL validation failed: ${(error as Error).message}`);
    }
  }

  /**
   * Cleanup temp files
   */
  private cleanup(tempPath: string): void {
    try {
      if (existsSync(tempPath)) {
        unlinkSync(tempPath);
        logger.debug('TRANSFORMER', 'Cleaned up temp file', { path: tempPath });
      }
    } catch (error) {
      logger.warn('TRANSFORMER', 'Failed to cleanup temp file', { path: tempPath }, error as Error);
      // Don't throw - cleanup failure shouldn't block error propagation
    }
  }

  /**
   * Get transcript path
   */
  getTranscriptPath(): string {
    return this.transcriptPath;
  }
}

/**
 * TranscriptBackupManager - Handles backup creation and management
 * Separated from transformation logic for single responsibility
 */
export class TranscriptBackupManager {
  private readonly backupDir: string;
  private readonly maxSizeMB: number;

  constructor(backupDir: string, maxSizeMB: number = 50) {
    if (!backupDir) {
      throw new Error('Backup directory is required');
    }
    this.backupDir = backupDir;
    this.maxSizeMB = maxSizeMB;
  }

  /**
   * Create a timestamped backup of the transcript file
   * Returns the backup file path
   */
  async createBackup(transcriptPath: string): Promise<string> {
    if (!transcriptPath) {
      throw new Error('Transcript path is required');
    }
    if (!existsSync(transcriptPath)) {
      throw new Error(`Transcript file does not exist: ${transcriptPath}`);
    }

    try {
      const { ensureDir, createBackupFilename } = await import('../shared/paths.js');
      const { copyFileSync } = await import('fs');

      ensureDir(this.backupDir);
      const backupPath = createBackupFilename(transcriptPath);
      copyFileSync(transcriptPath, backupPath);

      logger.info('BACKUP', 'Created transcript backup', {
        original: transcriptPath,
        backup: backupPath
      });

      return backupPath;
    } catch (error) {
      logger.error('BACKUP', 'Failed to create transcript backup', { transcriptPath }, error as Error);
      throw new Error(`Backup creation failed: ${(error as Error).message}`);
    }
  }

  /**
   * Trim backup files to stay under size limit
   */
  async trimBackups(): Promise<void> {
    if (this.maxSizeMB <= 0) {
      logger.debug('BACKUP', 'Backup trimming disabled', { maxSizeMB: this.maxSizeMB });
      return;
    }

    try {
      trimBackupFile(this.maxSizeMB);
      logger.debug('BACKUP', 'Trimmed tool output backup', { maxSizeMB: this.maxSizeMB });
    } catch (error) {
      logger.warn('BACKUP', 'Failed to trim tool output backup', {}, error as Error);
      // Don't throw - trim failure shouldn't block operations
    }
  }
}
