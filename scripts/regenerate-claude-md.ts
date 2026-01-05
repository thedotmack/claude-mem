#!/usr/bin/env bun
/**
 * Regenerate all folder CLAUDE.md files
 *
 * Usage: bun scripts/regenerate-claude-md.ts [--project=name] [--dry-run]
 *
 * This script:
 * 1. Queries the database for all unique folder paths from observations
 * 2. Uses the existing SessionSearch and ResultFormatter to get/format data
 * 3. Writes formatted CLAUDE.md files using the timeline format
 */

import { Database } from 'bun:sqlite';
import path from 'path';
import os from 'os';
import { existsSync, mkdirSync, writeFileSync, readFileSync, renameSync } from 'fs';

const DB_PATH = path.join(os.homedir(), '.claude-mem', 'claude-mem.db');

interface FolderInfo {
  folder: string;
  project: string;
  fileCount: number;
}

interface ObservationRow {
  id: number;
  title: string | null;
  subtitle: string | null;
  narrative: string | null;
  facts: string | null;
  type: string;
  created_at: string;
  created_at_epoch: number;
  files_modified: string | null;
  files_read: string | null;
  project: string;
  discovery_tokens: number | null;
}

// Import shared formatting utilities
import { formatTime, extractFirstFile, groupByDate } from '../src/shared/timeline-formatting.js';

// Type icon map (matches ModeManager)
const TYPE_ICONS: Record<string, string> = {
  'bugfix': '🔴',
  'feature': '🟣',
  'refactor': '🔄',
  'change': '✅',
  'discovery': '🔵',
  'decision': '⚖️',
  'session': '🎯',
  'prompt': '💬'
};

function getTypeIcon(type: string): string {
  return TYPE_ICONS[type] || '📝';
}

function estimateTokens(obs: ObservationRow): number {
  const size = (obs.title?.length || 0) +
    (obs.subtitle?.length || 0) +
    (obs.narrative?.length || 0) +
    (obs.facts?.length || 0);
  return Math.ceil(size / 4);
}

/**
 * Extract unique folder paths from observations
 */
function getUniqueFolders(db: Database, projectFilter?: string): FolderInfo[] {
  const query = projectFilter
    ? `SELECT files_read, files_modified, project FROM observations WHERE project = ?`
    : `SELECT files_read, files_modified, project FROM observations`;

  const rows = projectFilter
    ? db.prepare(query).all(projectFilter) as { files_read: string | null; files_modified: string | null; project: string }[]
    : db.prepare(query).all() as { files_read: string | null; files_modified: string | null; project: string }[];

  const folderMap = new Map<string, { project: string; fileCount: number }>();

  for (const row of rows) {
    const allFiles: string[] = [];

    if (row.files_read) {
      try {
        const parsed = JSON.parse(row.files_read);
        if (Array.isArray(parsed)) allFiles.push(...parsed);
      } catch {}
    }

    if (row.files_modified) {
      try {
        const parsed = JSON.parse(row.files_modified);
        if (Array.isArray(parsed)) allFiles.push(...parsed);
      } catch {}
    }

    for (const filePath of allFiles) {
      if (!filePath || filePath === '' || filePath === '/') continue;
      const folder = path.dirname(filePath);
      if (folder && folder !== '.' && folder !== '/') {
        const key = `${row.project}:${folder}`;
        const existing = folderMap.get(key);
        if (existing) {
          existing.fileCount++;
        } else {
          folderMap.set(key, { project: row.project, fileCount: 1 });
        }
      }
    }
  }

  return Array.from(folderMap.entries())
    .map(([key, info]) => ({
      folder: key.split(':').slice(1).join(':'),
      project: info.project,
      fileCount: info.fileCount
    }))
    .sort((a, b) => b.fileCount - a.fileCount);
}

/**
 * Query observations for a specific folder using the same logic as SessionSearch.findByFile
 */
function findObservationsByFolder(db: Database, folderPath: string, project: string, limit: number = 10): ObservationRow[] {
  // Use LIKE to match files that start with the folder path
  // This matches the pattern used in SessionSearch.buildFilterClause for 'files' filter
  const sql = `
    SELECT o.*, o.discovery_tokens
    FROM observations o
    WHERE o.project = ?
      AND (o.files_modified LIKE ? OR o.files_read LIKE ?)
    ORDER BY o.created_at_epoch DESC
    LIMIT ?
  `;

  const likePattern = `%${folderPath}%`;
  return db.prepare(sql).all(project, likePattern, likePattern, limit) as ObservationRow[];
}

/**
 * Extract first relevant file from an observation (modified OR read)
 * Falls back to "General" only if both are empty
 */
function extractRelevantFile(obs: ObservationRow, folderPath: string): string {
  // Try files_modified first
  if (obs.files_modified) {
    try {
      const modified = JSON.parse(obs.files_modified);
      if (Array.isArray(modified) && modified.length > 0) {
        // Find a file that's in the target folder
        for (const file of modified) {
          if (file.startsWith(folderPath)) {
            return path.relative(folderPath, file) || path.basename(file);
          }
        }
        // If no match in folder, use first file
        return path.relative(folderPath, modified[0]) || path.basename(modified[0]);
      }
    } catch {}
  }

  // Fall back to files_read
  if (obs.files_read) {
    try {
      const read = JSON.parse(obs.files_read);
      if (Array.isArray(read) && read.length > 0) {
        // Find a file that's in the target folder
        for (const file of read) {
          if (file.startsWith(folderPath)) {
            return path.relative(folderPath, file) || path.basename(file);
          }
        }
        // If no match in folder, use first file
        return path.relative(folderPath, read[0]) || path.basename(read[0]);
      }
    } catch {}
  }

  return 'General';
}

/**
 * Format observations using the same logic as ResultFormatter.formatSearchResults
 */
function formatObservationsForClaudeMd(observations: ObservationRow[], folderPath: string): string {
  const lines: string[] = [];
  lines.push('# Recent Activity');
  lines.push('');
  lines.push('<!-- This section is auto-generated by claude-mem. Edit content outside the tags. -->');
  lines.push('');

  if (observations.length === 0) {
    lines.push('*No recent activity*');
    return lines.join('\n');
  }

  // Group by date using the shared utility
  const byDate = groupByDate(observations, obs => obs.created_at);

  for (const [day, dayObs] of byDate) {
    lines.push(`### ${day}`);
    lines.push('');

    // Group by file within this day - using BOTH files_modified and files_read
    const byFile = new Map<string, ObservationRow[]>();
    for (const obs of dayObs) {
      const file = extractRelevantFile(obs, folderPath);
      if (!byFile.has(file)) byFile.set(file, []);
      byFile.get(file)!.push(obs);
    }

    // Render each file section (same format as ResultFormatter.formatSearchResults)
    for (const [file, fileObs] of byFile) {
      lines.push(`**${file}**`);
      lines.push('| ID | Time | T | Title | Read |');
      lines.push('|----|------|---|-------|------|');

      let lastTime = '';
      for (const obs of fileObs) {
        const time = formatTime(obs.created_at_epoch);
        const timeDisplay = time === lastTime ? '"' : time;
        lastTime = time;

        const icon = getTypeIcon(obs.type);
        const title = obs.title || 'Untitled';
        const tokens = estimateTokens(obs);

        lines.push(`| #${obs.id} | ${timeDisplay} | ${icon} | ${title} | ~${tokens} |`);
      }

      lines.push('');
    }
  }

  return lines.join('\n').trim();
}

/**
 * Write CLAUDE.md file with tagged content preservation
 */
function writeClaudeMdToFolder(folderPath: string, newContent: string): void {
  const claudeMdPath = path.join(folderPath, 'CLAUDE.md');
  const tempFile = `${claudeMdPath}.tmp`;

  mkdirSync(folderPath, { recursive: true });

  let existingContent = '';
  if (existsSync(claudeMdPath)) {
    existingContent = readFileSync(claudeMdPath, 'utf-8');
  }

  const startTag = '<claude-mem-context>';
  const endTag = '</claude-mem-context>';

  let finalContent: string;
  if (!existingContent) {
    finalContent = `${startTag}\n${newContent}\n${endTag}`;
  } else {
    const startIdx = existingContent.indexOf(startTag);
    const endIdx = existingContent.indexOf(endTag);

    if (startIdx !== -1 && endIdx !== -1) {
      finalContent = existingContent.substring(0, startIdx) +
        `${startTag}\n${newContent}\n${endTag}` +
        existingContent.substring(endIdx + endTag.length);
    } else {
      finalContent = existingContent + `\n\n${startTag}\n${newContent}\n${endTag}`;
    }
  }

  writeFileSync(tempFile, finalContent);
  renameSync(tempFile, claudeMdPath);
}

/**
 * Regenerate CLAUDE.md for a single folder
 */
function regenerateFolder(
  db: Database,
  folder: string,
  project: string,
  dryRun: boolean
): { success: boolean; observationCount: number; error?: string } {
  try {
    const observations = findObservationsByFolder(db, folder, project, 10);

    if (observations.length === 0) {
      return { success: false, observationCount: 0, error: 'No observations for folder' };
    }

    if (dryRun) {
      return { success: true, observationCount: observations.length };
    }

    const formatted = formatObservationsForClaudeMd(observations, folder);
    writeClaudeMdToFolder(folder, formatted);

    return { success: true, observationCount: observations.length };
  } catch (error) {
    return { success: false, observationCount: 0, error: String(error) };
  }
}

/**
 * Main function
 */
async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const projectArg = args.find(a => a.startsWith('--project='));
  const projectFilter = projectArg ? projectArg.split('=')[1] : undefined;

  console.log('=== CLAUDE.md Regeneration Script ===\n');

  // Open database
  console.log('Opening database...');
  const db = new Database(DB_PATH, { readonly: true, create: false });

  // Get unique folders
  console.log('Scanning observations for folder paths...');
  const folders = getUniqueFolders(db, projectFilter);

  if (folders.length === 0) {
    console.log('No folders found with observations.');
    db.close();
    process.exit(0);
  }

  console.log(`Found ${folders.length} unique folders.\n`);

  if (dryRun) {
    console.log('[DRY RUN] Would regenerate the following folders:\n');
  }

  // Process each folder
  let successCount = 0;
  let skipCount = 0;
  let errorCount = 0;

  for (let i = 0; i < folders.length; i++) {
    const { folder, project, fileCount } = folders[i];
    const progress = `[${i + 1}/${folders.length}]`;

    if (dryRun) {
      const observations = findObservationsByFolder(db, folder, project, 10);
      console.log(`${progress} ${folder} (${project}, ${fileCount} refs, ${observations.length} obs)`);
      if (observations.length > 0) successCount++;
      else skipCount++;
      continue;
    }

    process.stdout.write(`${progress} ${folder}... `);

    const result = regenerateFolder(db, folder, project, dryRun);

    if (result.success) {
      console.log(`OK (${result.observationCount} obs)`);
      successCount++;
    } else if (result.error?.includes('No observations')) {
      console.log('skipped (no data)');
      skipCount++;
    } else {
      console.log(`ERROR: ${result.error}`);
      errorCount++;
    }
  }

  db.close();

  // Summary
  console.log('\n=== Summary ===');
  console.log(`Total folders: ${folders.length}`);
  console.log(`Regenerated:   ${successCount}`);
  console.log(`Skipped:       ${skipCount}`);
  console.log(`Errors:        ${errorCount}`);

  if (dryRun) {
    console.log('\nRun without --dry-run to actually regenerate files.');
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
