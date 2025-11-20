/**
 * Tool Output Backup: Rolling backup of original tool outputs for Endless Mode restoration
 *
 * Purpose:
 * - Enable users to restore transcripts to pre-compression state if they disable Endless Mode
 * - Maintain rolling backup of original tool outputs with configurable size limit
 * - Efficient lookup by tool_use_id for restoration
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync, statSync } from 'fs';
import { join } from 'path';
import { BACKUPS_DIR, ensureDir } from './paths.js';

/**
 * Backup entry format stored in tool-outputs.jsonl
 */
export interface ToolOutputBackupEntry {
  tool_use_id: string;
  content: string | Array<Record<string, any>>;
  timestamp: number;
  size_bytes: number;
}

/**
 * Backup file info for diagnostics
 */
export interface BackupInfo {
  exists: boolean;
  sizeMB: number;
  entryCount: number;
  oldestTimestamp?: number;
  newestTimestamp?: number;
}

const BACKUP_FILE = join(BACKUPS_DIR, 'tool-outputs.jsonl');

/**
 * Append original tool output to rolling backup file
 */
export function appendToolOutput(
  toolUseId: string,
  content: string | Array<Record<string, any>>,
  timestamp: number = Date.now()
): void {
  ensureDir(BACKUPS_DIR);

  const contentStr = typeof content === 'string' ? content : JSON.stringify(content);
  const sizeBytes = Buffer.byteLength(contentStr, 'utf8');

  const entry: ToolOutputBackupEntry = {
    tool_use_id: toolUseId,
    content,
    timestamp,
    size_bytes: sizeBytes
  };

  const line = JSON.stringify(entry) + '\n';
  appendFileSync(BACKUP_FILE, line, 'utf8');
}

/**
 * Trim backup file to stay under size limit
 * Drops oldest entries until size is under maxSizeMB
 */
export function trimBackupFile(maxSizeMB: number): void {
  if (!existsSync(BACKUP_FILE)) {
    return;
  }

  const stats = statSync(BACKUP_FILE);
  const currentSizeMB = stats.size / (1024 * 1024);

  // If under limit, nothing to do
  if (currentSizeMB <= maxSizeMB) {
    return;
  }

  // Read all entries
  const content = readFileSync(BACKUP_FILE, 'utf8');
  const lines = content.trim().split('\n').filter(line => line.length > 0);

  const entries: ToolOutputBackupEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Skip malformed lines
      continue;
    }
  }

  // Sort by timestamp (oldest first)
  entries.sort((a, b) => a.timestamp - b.timestamp);

  // Calculate how many entries to keep
  const maxBytes = maxSizeMB * 1024 * 1024;
  let totalBytes = 0;
  let keepFromIndex = 0;

  // Work backwards from newest entries
  for (let i = entries.length - 1; i >= 0; i--) {
    const entrySize = entries[i].size_bytes + 100; // +100 for JSON overhead
    if (totalBytes + entrySize > maxBytes) {
      keepFromIndex = i + 1;
      break;
    }
    totalBytes += entrySize;
  }

  // Keep only entries that fit under limit
  const entriesToKeep = entries.slice(keepFromIndex);

  // Rewrite file with trimmed entries
  const newContent = entriesToKeep.map(e => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(BACKUP_FILE, newContent, 'utf8');
}

/**
 * Look up original tool output by tool_use_id
 * Returns null if not found
 */
export function lookupToolOutput(toolUseId: string): string | Array<Record<string, any>> | null {
  if (!existsSync(BACKUP_FILE)) {
    return null;
  }

  const content = readFileSync(BACKUP_FILE, 'utf8');
  const lines = content.trim().split('\n').filter(line => line.length > 0);

  // Search backwards (newest first) for better performance
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]) as ToolOutputBackupEntry;
      if (entry.tool_use_id === toolUseId) {
        return entry.content;
      }
    } catch {
      // Skip malformed lines
      continue;
    }
  }

  return null;
}

/**
 * Get backup file info for diagnostics
 */
export function getBackupInfo(): BackupInfo {
  if (!existsSync(BACKUP_FILE)) {
    return {
      exists: false,
      sizeMB: 0,
      entryCount: 0
    };
  }

  const stats = statSync(BACKUP_FILE);
  const sizeMB = stats.size / (1024 * 1024);

  const content = readFileSync(BACKUP_FILE, 'utf8');
  const lines = content.trim().split('\n').filter(line => line.length > 0);

  let oldestTimestamp: number | undefined;
  let newestTimestamp: number | undefined;

  if (lines.length > 0) {
    try {
      const first = JSON.parse(lines[0]) as ToolOutputBackupEntry;
      const last = JSON.parse(lines[lines.length - 1]) as ToolOutputBackupEntry;
      oldestTimestamp = first.timestamp;
      newestTimestamp = last.timestamp;
    } catch {
      // Ignore parse errors
    }
  }

  return {
    exists: true,
    sizeMB: Math.round(sizeMB * 100) / 100,
    entryCount: lines.length,
    oldestTimestamp,
    newestTimestamp
  };
}
